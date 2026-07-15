import serverModule from '../src/server';

const getFetch = (mod: any) => {
  if (!mod) return undefined;
  if (typeof mod === 'function') return mod;
  if (mod.default && typeof mod.default === 'function') return mod.default;
  if (mod.fetch && typeof mod.fetch === 'function') return (req: Request, env?: unknown, ctx?: unknown) => mod.fetch(req, env, ctx);
  return undefined;
};

const handler = getFetch(serverModule) ?? (serverModule && serverModule.default && serverModule.default.fetch);

export default async function edgeHandler(request: Request) {
  if (!handler) {
    return new Response('Server entry not found', { status: 500 });
  }

  try {
    return await handler(request, undefined, undefined);
  } catch (err) {
    console.error(err);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export const config = { runtime: 'edge' };
