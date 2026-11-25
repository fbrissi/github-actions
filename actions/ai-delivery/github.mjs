// Minimal GitHub REST and GraphQL client on fetch, so the scripts need no dependencies.

export function createClient({ token, apiUrl = 'https://api.github.com', graphqlUrl = '', fetchImpl = globalThis.fetch }) {
  const base = apiUrl.replace(/\/$/, '');

  async function request(method, path, body) {
    const url = path.startsWith('https://') || path.startsWith('http://') ? path : `${base}${path}`;
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'fbrissi-github-actions-ai-delivery',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const error = new Error(`${method} ${path} failed with ${response.status}: ${data?.message ?? text}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return { status: response.status, data, headers: response.headers };
  }

  async function paginate(path) {
    let url = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    const items = [];
    while (url) {
      const { data, headers } = await request('GET', url);
      items.push(...(Array.isArray(data) ? data : []));
      const next = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '');
      url = next ? next[1] : '';
    }
    return items;
  }

  async function graphql(query, variables) {
    const { data } = await request('POST', graphqlUrl || `${base}/graphql`, { query, variables });
    if (data?.errors?.length) throw new Error(`GraphQL failed: ${data.errors.map((error) => error.message).join('; ')}`);
    return data.data;
  }

  return { request, paginate, graphql };
}
