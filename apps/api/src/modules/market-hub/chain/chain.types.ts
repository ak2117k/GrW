export type OptionSide = 'CE' | 'PE';

/** One contract's Greeks from Angel's optionGreek (IV in PERCENT, e.g. 13.36). */
export interface OptionGreekRow {
  strike: number;
  optionType: OptionSide;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}
