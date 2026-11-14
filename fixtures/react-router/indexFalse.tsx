// A route that says `index={false}`, which React Router reads the same
// as leaving `index` out. With no path either, the route is a layout:
// it serves no URL of its own and only groups the routes inside it.

import { Route, Routes } from "react-router-dom";

import {
  BoardColumns,
  ProjectBoard,
  ProjectList,
  ProjectsLayout,
} from "./pages";

export function ProjectRoutes() {
  return (
    <Routes>
      <Route path="/projects" element={<ProjectsLayout />}>
        <Route index element={<ProjectList />} />
        <Route index={false} element={<ProjectBoard />}>
          <Route path="board" element={<BoardColumns />} />
        </Route>
      </Route>
    </Routes>
  );
}
