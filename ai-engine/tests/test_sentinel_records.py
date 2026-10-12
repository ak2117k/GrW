import json
from datetime import datetime, timedelta, timezone

from src.corpus import sentinel_records as sr
from tests.fakes import FakeConn

T0 = datetime(2026, 10, 9, 5, 0, tzinfo=timezone.utc)


def _packet(symbol="SYM1", ltp=101.0):
    return {"position": {"symbol": symbol, "kind": "INTRADAY", "segment": "EQ", "side": "BUY", "qty": 10,
                         "entryPrice": 100.0, "ltp": ltp}, "money": {"netPnl": 10}}


def _call(cid, at, packet, job="sentinel.judge", position_id=None, user="u1"):
    return {"id": cid, "job": job, "userId": user, "positionId": position_id, "createdAt": at,
            "request": {"model": "m", "messages": [{"role": "user", "content": json.dumps(packet)}]},
            "response": {"content": [{"type": "text", "text": '{"verdict":"HOLD"}'}], "stop_reason": "end_turn"}}


def _verdict(vid, at, packet, tracker="trk1", user="u1", verdict="HOLD"):
    return {"id": vid, "userId": user, "trackerId": tracker, "symbol": packet["position"]["symbol"],
            "verdict": verdict, "confidence": "high", "thesisStatus": "INTACT", "recoveryAvailable": False,
            "reason": "fine", "invalidationPoint": None, "reviewInSec": 120, "triggeredBy": ["heartbeat"],
            "packet": packet, "createdAt": at}


def _conn():
    p1, p2 = _packet("SYM1", 101.0), _packet("SYM2", 55.0)
    calls = [
        _call("call-1", T0, p1),
        _call("call-2", T0 + timedelta(minutes=5), p2, job="sentinel.overnight"),
        _call("call-3", T0, p1, job="sentinel.thesis"),
        {**_call("call-4", T0, p1), "response": None},  # failed call: excluded
    ]
    verdicts = [
        _verdict("v1", T0 + timedelta(seconds=2), p1, tracker="trk1"),
        _verdict("v-other", T0 + timedelta(seconds=1), _packet("SYM9"), tracker="trk9"),
        _verdict("v2", T0 + timedelta(minutes=5, seconds=3), p2, tracker="trk2", verdict="EXIT_ARMED"),
    ]
    return FakeConn(ai_calls=calls, verdicts=verdicts)


def test_two_calls_two_records_keyed_by_call_id():
    conn = _conn()
    counts = sr.build_from_ai_calls(conn)
    assert counts["inserted"] == 2
    assert counts["skip:job:sentinel.thesis"] == 1
    assert set(conn.records) == {("sentinel", "call-1"), ("sentinel", "call-2")}
    r1 = conn.records[("sentinel", "call-1")]
    assert r1["kind"] == "POSITION_REVIEW" and r1["aiCallIds"] == ["call-1"]
    assert json.loads(r1["decision"])["verdictId"] == "v1"  # packet match, not the nearer v-other
    assert r1["setupGroupKey"] == "tracker:trk1"
    assert r1["outcome"] is None and r1["symbol"] == "SYM1" and r1["direction"] == "LONG"
    r2 = conn.records[("sentinel", "call-2")]
    assert r2["kind"] == "OVERNIGHT_REVIEW"
    assert json.loads(r2["decision"])["verdict"] == "EXIT_ARMED"


def test_rerun_no_duplicates():
    conn = _conn()
    sr.build_from_ai_calls(conn)
    again = sr.build_from_ai_calls(conn)
    assert again["inserted"] == 0 and again["updated"] == 2
    assert len(conn.records) == 2


def test_rerun_keeps_outcome_filled_later():
    conn = _conn()
    sr.build_from_ai_calls(conn)
    conn.records[("sentinel", "call-1")]["outcome"] = '{"netPnl": 5}'
    sr.build_from_ai_calls(conn)
    assert conn.records[("sentinel", "call-1")]["outcome"] == '{"netPnl": 5}'


def test_position_id_match_preferred_and_unmatched_counted():
    p = _packet("SYM1")
    conn = FakeConn(
        ai_calls=[_call("c1", T0, p, position_id="trk7"), _call("c2", T0 + timedelta(hours=1), p)],
        verdicts=[_verdict("vA", T0 + timedelta(seconds=5), _packet("SYMX"), tracker="trk7")],
    )
    counts = sr.build_from_ai_calls(conn)
    assert json.loads(conn.records[("sentinel", "c1")]["decision"])["verdictId"] == "vA"
    d2 = json.loads(conn.records[("sentinel", "c2")]["decision"])
    assert d2["verdict"] is None and d2["raw"] == '{"verdict":"HOLD"}'
    assert counts["verdict:unmatched"] == 1 and counts["verdict:matched"] == 1


def test_unparseable_packet_skipped():
    call = _call("c1", T0, _packet())
    call["request"] = {"messages": [{"role": "user", "content": "not json"}]}
    counts = sr.build_from_ai_calls(FakeConn(ai_calls=[call]))
    assert counts["skip:no-packet"] == 1 and counts["inserted"] == 0
