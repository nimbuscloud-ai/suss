// A generic component keeps its type parameter through forwardRef by
// casting the wrapped function back to a generic signature, so the
// export is a wrapper call under a cast.

import { forwardRef } from "react";

interface FilterButtonProps<TField> {
  fields: TField[];
  onPick: (field: TField) => void;
}

function FilterButtonComponent<TField>(
  { fields, onPick }: FilterButtonProps<TField>,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  return (
    <button ref={ref} type="button" onClick={() => onPick(fields[0])}>
      Filter
    </button>
  );
}

export const FilterButton = forwardRef(FilterButtonComponent) as <TField>(
  props: FilterButtonProps<TField> & { ref?: React.Ref<HTMLButtonElement> },
) => ReturnType<typeof FilterButtonComponent>;
