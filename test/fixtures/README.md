Public, unauthenticated response fixtures captured on 2026-09-09:

- `page.pb`: https://capi.yangshipin.cn/api/oms/pc/page/PG00000004
- `programmes.pb`: https://capi.yangshipin.cn/api/yspepg/program/600001859/20260909

These are Protocol Buffer payloads, not JSON. The schema field numbers were checked
against the JavaScript shipped by https://www.yangshipin.cn/tv/home and its actual
browser network requests. Tests use snapshots so they do not need the live service.
