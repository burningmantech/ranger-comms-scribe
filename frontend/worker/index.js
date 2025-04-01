import {
    getAssetFromKV,
    mapRequestToAsset,
  } from "@cloudflare/kv-asset-handler";
  
  /**
   * The DEBUG flag will do two things that help during development:
   * 1. we will skip caching on the edge, which makes it easier to
   *    debug.
   * 2. we will return an error message on exception in your Response rather
   *    than the default 404.html page.
   */
  const DEBUG = false;
  
  addEventListener("fetch", (event) => {
    try {
      event.respondWith(handleEvent(event));
    } catch (e) {
      if (DEBUG) {
        return event.respondWith(
          new Response(e.message || e.toString(), {
            status: 500,
          })
        );
      }
      event.respondWith(new Response("Internal Error", { status: 500 }));
    }
  });
  
  function addHeaders(response) {
    if (response) {
      if (!response.headers) {
        response.headers = new Headers();
      }
      response.headers.set("strict-transport-security", "max-age=315576000; includeSubDomains; preload");
    }
    return response;
  }
  
  async function handleEvent(event) {
    const url = new URL(event.request.url);
    let options = {};
  
    /**
     * You can add custom logic to how we fetch your assets
     * by configuring the function `mapRequestToAsset`
     */
    // options.mapRequestToAsset = handlePrefix(/^\/docs/)
  
    try {
      if (DEBUG) {
        // customize caching
        options.cacheControl = {
          bypassCache: true,
        };
      }
      let response = await getAssetFromKV(event, options);
      return addHeaders(response);
    } catch (e) {
      // Fall back to serving `/index.html` on errors.
      let response = await getAssetFromKV(event, {
        mapRequestToAsset: (req) =>
          new Request(`${new URL(req.url).origin}/index.html`, req),
      });
      return addHeaders(response);
    }
  }
  
  /**
   * Here's one example of how to modify a request to
   * remove a specific prefix, in this case `/docs` from
   * the url. This can be useful if you are deploying to a
   * route on a zone, or if you only want your static content
   * to exist at a specific path.
   */
  function handlePrefix(prefix) {
    return (request) => {
      // compute the default (e.g. / -> index.html)
      let defaultAssetKey = mapRequestToAsset(request);
      let url = new URL(defaultAssetKey.url);
  
      // strip the prefix from the path for lookup
      url.pathname = url.pathname.replace(prefix, "/");
  
      // inherit all other props from the default request
      return new Request(url.toString(), defaultAssetKey);
    };
  }
  