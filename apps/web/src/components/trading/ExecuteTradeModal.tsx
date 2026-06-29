import { Modal } from '@/components/common';
import OrderTicket from './OrderTicket';

interface ExecuteTradeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Thin wrapper around the reusable OrderTicket form. The order-entry logic now
 * lives in OrderTicket (also consumed by the Manual Trade page); this modal just
 * hosts it for the Auto-Trade and Positions pages. External API (isOpen/onClose)
 * and behavior are unchanged.
 */
export default function ExecuteTradeModal({ isOpen, onClose }: ExecuteTradeModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Execute Trade" size="lg">
      <OrderTicket variant="modal" onSubmitted={onClose} />
    </Modal>
  );
}
