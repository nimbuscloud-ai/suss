// Ambient stub of the express surface this fixture uses. The fixture
// has no node_modules, so the module shape is declared inline. A
// consuming project would install express and @types/express.

declare module "express" {
  export interface Request {
    params: Record<string, string>;
  }

  export interface Response {
    status(code: number): Response;
    json(body: unknown): void;
  }

  export type NextFunction = (err?: unknown) => void;

  type Handler = (req: Request, res: Response, next: NextFunction) => void;

  export interface Router {
    get(path: string, handler: (req: Request, res: Response) => void): void;
    all(path: string, handler: Handler): void;
    use(path: string, router: Router): void;
  }

  export function Router(): Router;

  interface Application extends Router {
    listen(port: number, cb?: () => void): void;
  }

  export default function express(): Application;
}
