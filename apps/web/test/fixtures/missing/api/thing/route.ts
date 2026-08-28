// Deliberately exports NO `access`. This is the case the boot check exists for.
export function GET() { return new Response('ok'); }
