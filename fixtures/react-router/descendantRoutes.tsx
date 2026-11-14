// Routes written inside another route's `element`, the way a section of
// an app declares its own routes. React Router renders them as part of
// the element, relative to the URL the outer route matched.

import { Route, Routes } from "react-router-dom";

import {
  Compose,
  HelpArticles,
  HelpLayout,
  InboxLayout,
  Thread,
} from "./pages";

export function MailRoutes() {
  return (
    <Routes>
      <Route
        path="/inbox"
        element={
          <InboxLayout>
            <Routes>
              <Route path="compose" element={<Compose />} />
            </Routes>
          </InboxLayout>
        }
      >
        <Route path=":threadId" element={<Thread />} />
      </Route>
      <Route
        path="/help/*"
        element={
          <HelpLayout>
            <Routes>
              <Route path="articles" element={<HelpArticles />} />
            </Routes>
          </HelpLayout>
        }
      />
    </Routes>
  );
}
