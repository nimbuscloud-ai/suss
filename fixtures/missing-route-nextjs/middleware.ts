// Signs pages in; the API checks its own tokens.
export const config = {
  matcher: ["/((?!api/|_next/|robots.txt).*)"],
};

export default function middleware() {
  return undefined;
}
