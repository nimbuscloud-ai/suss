// A route tree written in JSX, the way most React Router apps declare
// what serves which URL: a layout route whose children join its path,
// an index route answering the parent's own path, and one route whose
// path is built at runtime and cannot be read.

import { Route, Routes } from "react-router-dom";

import { Settings, UserDetail, UsersIndex } from "./pages";

const section = "general";
const settingsPath = `/settings/${section}`;

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/users">
        <Route index element={<UsersIndex />} />
        <Route path=":id" element={<UserDetail />} />
      </Route>
      <Route path={settingsPath} element={<Settings />} />
    </Routes>
  );
}
