import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { CloseIcon } from '../icons';
import { useUi } from '../ui';

/** 공통 팝업: Esc·바깥 클릭으로 닫힘, 열려 있는 동안 뒤 화면 스크롤 잠금. */
export function Modal({ title, onClose, children, wide, label, variant = '' }: { title: ReactNode; onClose?: () => void; children: ReactNode; wide?: boolean; label?: string; variant?: string }) {
  const { closeModal, origin } = useUi();
  const [closing, setClosing] = useState(false);
  const downOnBackdrop = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!origin || !variant.includes('action-modal') || !dialog.current) return;
    const r = dialog.current.getBoundingClientRect();
    setOffset({ '--dx': `${origin.x - r.left - r.width / 2}px`, '--dy': `${origin.y - r.top - r.height / 2}px` } as CSSProperties);
  }, [origin, variant]);
  const close = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => (onClose ?? closeModal)(), 200);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, []);

  return (
    <div className={`backdrop${closing ? ' closing' : ''}`}
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnBackdrop.current) close(); }}>
      <div ref={dialog} className={`modal${wide ? ' wide' : ''} ${variant}`} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : undefined)} style={offset}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={close} aria-label="닫기" title="닫기"><CloseIcon /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
