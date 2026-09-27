import { getOriginBase } from './_domain';
import { indexSingleProduct, deleteProductVectors } from './_visual_indexer';
export async function onRequestPost(context: any) {
  const { request, env } = context;
  try {
    const data = await request.json();
    const { items, action } = data; // items: array of products, action: 'upsert' | 'delete' | 'sync_all'
    
    if (!items || !Array.isArray(items)) {
      return new Response('Invalid items payload', { status: 400 });
    }

    if (action === 'delete') {
      const ids = items.map((i: any) => String(i.id || i)).filter(Boolean);
      if (ids.length > 0) {
        // 1. Guaranteed immediate Vectorize vector deletion for deleted products
        await deleteProductVectors(env, ids);

        const r2KeysToDelete: string[] = [];
        let softDeletedCount = 0;
        let hardDeletedCount = 0;

        for (const id of ids) {
          const prodRow = await env.DB.prepare('SELECT id, data FROM products WHERE id = ?').bind(id).first();
          if (!prodRow) continue;

          let prodData: any = {};
          try {
            prodData = JSON.parse(prodRow.data);
          } catch (e) {}

          const urls: string[] = [];
          if (prodData.image) urls.push(prodData.image);
          if (prodData.thumbnail) urls.push(prodData.thumbnail);
          if (Array.isArray(prodData.images)) urls.push(...prodData.images);
          if (Array.isArray(prodData.thumbnails)) urls.push(...prodData.thumbnails);
          if (Array.isArray(prodData.colors)) prodData.colors.forEach((c: any) => c?.image && urls.push(c.image));
          if (Array.isArray(prodData.variants)) prodData.variants.forEach((v: any) => v?.image && urls.push(v.image));

          const extractKey = (u: any): string | null => {
            if (!u || typeof u !== 'string') return null;
            const clean = u.split('?')[0].split('#')[0].trim();
            const match = clean.match(/(uploads\/[^\s]+)$/);
            return match ? match[1] : null;
          };

          const productKeys = Array.from(new Set(
            urls.map(extractKey).filter(Boolean) as string[]
          ));

          // Check if product ID or any of its image keys are actively referenced in:
          // 1. Active standard orders (orders where isDeleted is not 1)
          // 2. Incomplete orders
          let isUsedInDashboard = false;

          const searchPatternId = `"id":"${id}"`;
          const orderMatch = await env.DB.prepare(
            `SELECT id FROM orders WHERE (json_extract(data, '$.isDeleted') IS NULL OR json_extract(data, '$.isDeleted') != 1) AND instr(data, ?) > 0 LIMIT 1`
          ).bind(searchPatternId).first();

          if (orderMatch) {
            isUsedInDashboard = true;
          } else {
            for (const key of productKeys) {
              const oKeyMatch = await env.DB.prepare(
                `SELECT id FROM orders WHERE (json_extract(data, '$.isDeleted') IS NULL OR json_extract(data, '$.isDeleted') != 1) AND instr(data, ?) > 0 LIMIT 1`
              ).bind(key).first();
              if (oKeyMatch) {
                isUsedInDashboard = true;
                break;
              }
            }
          }

          if (isUsedInDashboard) {
            // SOFT-DELETE (HIDE): Keep in D1 so existing orders, profits, prices, and images never break
            prodData.isDeleted = true;
            prodData.isVisible = false;
            await env.DB.prepare('UPDATE products SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .bind(JSON.stringify(prodData), id)
              .run();
            softDeletedCount++;
          } else {
            // HARD-DELETE: Safely remove from D1
            await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
            hardDeletedCount++;

            // Check if keys are used in any other product or setting before deleting from R2
            for (const key of productKeys) {
              const otherProd = await env.DB.prepare(
                'SELECT id FROM products WHERE id != ? AND instr(data, ?) > 0 LIMIT 1'
              ).bind(id, key).first();
              const settingsMatch = await env.DB.prepare(
                'SELECT key FROM settings WHERE instr(value, ?) > 0 LIMIT 1'
              ).bind(key).first();

              if (!otherProd && !settingsMatch) {
                r2KeysToDelete.push(key);
              }
            }
          }
        }

        // Clean up visual embeddings from Vectorize
        if (env.VECTORIZE && ids.length > 0) {
          try {
            await env.VECTORIZE.deleteByIds(ids.map((id: any) => String(id)));
          } catch (e) {
            console.warn('[Vectorize] Failed to delete embeddings for products:', ids, e);
          }
        }

        // Broadcast deletes to connected retails
        try {
          const settingsRes = await env.DB.prepare("SELECT value FROM settings WHERE key = 'registered_retails'").first();
          const storeSettingsRes = await env.DB.prepare("SELECT value FROM settings WHERE key = 'websiteSettings'").first();
          const storeSettings = storeSettingsRes && storeSettingsRes.value ? JSON.parse(storeSettingsRes.value) : {};
          const masterApiKey = storeSettings?.apiSync?.masterApiKey || '';

          if (settingsRes && settingsRes.value) {
            const retails = JSON.parse(settingsRes.value);
            if (retails && retails.length > 0) {
              const broadcastData = JSON.stringify({ deletedIds: ids });
              await Promise.all(retails.map((retailUrl: string) => 
                fetch(`${retailUrl}/api/sync_apply`, {
                  method: 'POST',
                  headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${masterApiKey}`
                  },
                  body: broadcastData
                }).catch(() => {})
              ));
            }
          }
        } catch (e) {}

        // Reliably batch delete orphaned R2 image keys
        if (r2KeysToDelete.length > 0 && env.BUCKET) {
          const uniqueKeys = Array.from(new Set(r2KeysToDelete));
          try {
            await env.BUCKET.delete(uniqueKeys);
            console.log(`[R2] Successfully deleted ${uniqueKeys.length} orphaned image(s):`, uniqueKeys);
          } catch (r2Err) {
            console.error('[R2] Batch delete failed, attempting fallback individual delete:', r2Err);
            await Promise.allSettled(uniqueKeys.map((k: string) => env.BUCKET.delete(k)));
          }
        }

        // Invalidate public_state cache
        const cache = (caches as any).default;
        const url = new URL('/api/public_state', request.url);
        if (context.waitUntil) {
          context.waitUntil(cache.delete(new Request(url.toString())));
        } else {
          await cache.delete(new Request(url.toString()));
        }

        return Response.json({ success: true, deleted: ids.length, softDeleted: softDeletedCount, hardDeleted: hardDeletedCount });
      }
      return Response.json({ success: true, deleted: 0 });
    }
    
    if (action === 'sync_all') {
      // Overwrite all products (e.g. from ZIP import)
      await env.DB.prepare('DELETE FROM products').run();
      // Insert in batches
      const stmts = items.map((p: any) => 
        env.DB.prepare('INSERT INTO products (id, data) VALUES (?, ?)').bind(p.id, JSON.stringify(p))
      );
      if (stmts.length > 0) {
        for (let i = 0; i < stmts.length; i += 50) {
          const chunk = stmts.slice(i, i + 50);
          await env.DB.batch(chunk);
        }
      }
      return Response.json({ success: true, synced: items.length });
    }

    // Default: 'upsert'
    const stmts = items.map((p: any) => 
      env.DB.prepare('INSERT INTO products (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP').bind(p.id, JSON.stringify(p))
    );
    if (stmts.length > 0) {
        // D1 batch size limit is typically 100
        for (let i = 0; i < stmts.length; i += 50) {
          const chunk = stmts.slice(i, i + 50);
          await env.DB.batch(chunk);
        }
    }

    // Automatic background visual indexing for upserted products (non-blocking)
    if (context.waitUntil && items.length > 0) {
      context.waitUntil((async () => {
        for (const item of items) {
          if (item && item.id) {
            await indexSingleProduct(env, item).catch(() => {});
          }
        }
      })());
    }
    
    // Broadcast changes to connected retails
    try {
        const settingsRes = await env.DB.prepare("SELECT value FROM settings WHERE key = 'registered_retails'").first();
        const storeSettingsRes = await env.DB.prepare("SELECT value FROM settings WHERE key = 'websiteSettings'").first();
        const storeSettings = storeSettingsRes && storeSettingsRes.value ? JSON.parse(storeSettingsRes.value) : {};
        const masterApiKey = storeSettings?.apiSync?.masterApiKey || '';

        if (settingsRes && settingsRes.value) {
            const retails = JSON.parse(settingsRes.value);
            if (retails && retails.length > 0) {
                const url = new URL(request.url);
                const origin = url.origin;
                const originBase = getOriginBase(env, origin);
                
                const broadcastProducts = items.map((p: any) => {
                    const pCopy = { ...p };
                    if (pCopy.image && pCopy.image.startsWith('/')) pCopy.image = originBase + pCopy.image;
                    if (pCopy.images) pCopy.images = pCopy.images.map((img: string) => img.startsWith('/') ? originBase + img : img);
                    return pCopy;
                });
                const broadcastData = JSON.stringify({ products: broadcastProducts, isStockOnly: true });
                await Promise.all(retails.map((retailUrl: string) => 
                    fetch(`${retailUrl}/api/sync_apply`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${masterApiKey}`
                        },
                        body: broadcastData
                    }).catch(() => {})
                ));
            }
        }
    } catch (e) {}
    
    // Invalidate public_state cache
    const cache = (caches as any).default;
    const url = new URL('/api/public_state', request.url);
    if (context.waitUntil) {
      context.waitUntil(cache.delete(new Request(url.toString())));
    } else {
      await cache.delete(new Request(url.toString()));
    }

    return Response.json({ success: true, modified: items.length });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
