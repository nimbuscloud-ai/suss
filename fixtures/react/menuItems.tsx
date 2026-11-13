// Styled parts that one factory makes. Each export is the component the
// factory's forwardRef call hands back, and both share its render
// function.

import { forwardRef } from "react";

function styledDiv(className: string) {
  return forwardRef<HTMLDivElement, { children?: React.ReactNode }>(
    (props, ref) => <div ref={ref} className={className} {...props} />,
  );
}

export const MenuItemLabel = styledDiv("menu-item-label");
export const MenuItemIcon = styledDiv("menu-item-icon");
