export async function onRequestPost({ request, env }: any) {
  try {
    const { urlsToCheck } = await request.json();
    if (!urlsToCheck || !Array.isArray(urlsToCheck) || urlsToCheck.length === 0) {
      return Response.json({ success: true, deleted: 0 });
    }

    const promises = [];

    // 3. Check each URL
    for (const url of urlsToCheck) {
      if (!url || typeof url !== 'string') continue;
      
      // Look for the URL exactly in the JSON string
      const clean = url.split('?')[0].split('#')[0].trim();
      const match = clean.match(/(uploads\/[^\s]+)$/);
      if (match && match[1]) {
        const key = match[1];
        
        // Search in D1 using instr for fast, unburstable search
        const productsMatch = await env.DB.prepare('SELECT id FROM products WHERE instr(data, ?) > 0 LIMIT 1').bind(key).first();
        const ordersMatch = await env.DB.prepare('SELECT id FROM orders WHERE instr(data, ?) > 0 LIMIT 1').bind(key).first();
        const settingsMatch = await env.DB.prepare('SELECT key FROM settings WHERE instr(value, ?) > 0 LIMIT 1').bind(key).first();
        
        if (!productsMatch && !ordersMatch && !settingsMatch) {
          // If not found in DB, safe to delete!
          if (env.BUCKET) {
            promises.push(env.BUCKET.delete(key).then(() => key));
          }
        }
      }
    }

    const deletedKeys = await Promise.all(promises);
    return Response.json({ success: true, deleted: deletedKeys.length, deletedKeys });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
