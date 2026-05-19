import { useRef } from 'react';

/**
 * Returns props for a modal backdrop that only triggers `onClose` when the user actually
 * clicks the backdrop — not when they start a drag (e.g. text selection) inside the modal
 * content and happen to release the mouse over the backdrop.
 *
 * The standard `onClick={() => onClose()}` pattern fires whenever the click event bubbles
 * to the backdrop, including when mousedown was on inner content and mouseup landed on the
 * backdrop. By tracking the mousedown target and only closing when both mousedown and the
 * eventual click are on the backdrop itself, drag-then-release-outside is preserved.
 *
 * Usage:
 *   const backdropProps = useBackdropClose(() => setOpen(false));
 *   <div {...backdropProps} style={backdropStyle}>
 *     <div onClick={(e) => e.stopPropagation()}>...modal content...</div>
 *   </div>
 */
export function useBackdropClose(onClose: () => void) {
  const mouseDownOnBackdropRef = useRef(false);
  return {
    onMouseDown: (e: React.MouseEvent) => {
      mouseDownOnBackdropRef.current = e.target === e.currentTarget;
    },
    onClick: (e: React.MouseEvent) => {
      if (mouseDownOnBackdropRef.current && e.target === e.currentTarget) {
        onClose();
      }
      mouseDownOnBackdropRef.current = false;
    },
  };
}
