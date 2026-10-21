// A project barrel that re-exports the hooks. The pack reads imports by
// the module written at the import, so it does not see calls made
// through this file.

export { useMutation, useQuery } from "@tanstack/react-query";
