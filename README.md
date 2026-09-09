# autoEPG

自动获取[央视频电视页](https://www.yangshipin.cn/tv/home)节目单，每日生成标准 **XMLTV EPG**，按日期发布到 GitHub Releases。无需服务器、央视频账号或个人访问令牌。

## 当天订阅

**[https://github.com/TvWasm/autoEPG/releases/latest/download/epg.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg.xml)**

此固定地址只提供当天节目单，文件是未压缩的 UTF-8 XML，没有 `.gz`。播放器需要支持 HTTPS 重定向。

## 日期版本

版本号和 tag 均为 `YYYY-MM-DD`，每个版本内的文件都叫 `epg.xml`。例如北京时间 2026-09-09：

| 版本 | 发布状态 | 文件内容 |
| --- | --- | --- |
| `2026-09-08` | 历史正式 Release | 9 月 8 日节目 |
| `2026-09-09` | 正式 Release，**Latest** | 9 月 9 日节目 |
| `2026-09-10` | **Pre-release** | 9 月 10 日节目 |
| `2026-09-11` | **Pre-release** | 9 月 11 日节目 |

指定日期的固定下载格式：

```text
https://github.com/TvWasm/autoEPG/releases/download/2026-09-09/epg.xml
```

到 9 月 10 日刷新时，`2026-09-10` 转为正式版并设为 Latest，9 月 9 日保留为历史版。源站调整节目后，刷新会**替换同日期版本的附件**，不会再创建按运行次数编号的版本。

每个日期版本附带 `channels.json`（频道映射）、`manifest.json`（节目数、文件大小、更新时间、数据覆盖情况）和 `SHA256SUMS`（校验和）。每个 XML 独立包含所需频道定义；与该日期相交的跨午夜节目保留真实起止时间，因此边界节目可能出现在相邻两天的文件中。

## 更新规则

[Update EPG 工作流](https://github.com/TvWasm/autoEPG/actions/workflows/epg.yml) 每天北京时间 **00:00** 运行一次，对应 UTC `0 16 * * *`。GitHub 排队可能延迟，尤其是整点，文件不保证零点整完成发布。

- 默认刷新过去 3 天、今天和未来 3 天，以源站实际公布的日期为准。范围之外的已发布历史版本保留。
- 动态发现频道及节目日期；额外读取起始日前一天，补全跨午夜节目。
- 未来日期只发布为 Pre-release，不会抢占 Latest。
- 支持 Actions → Update EPG → Run workflow 手动刷新；推送 `main` 后也会测试并刷新，PR 仅测试。
- 每个请求最多尝试 3 次，最多 4 个并发。至少发现 50 个频道且今天频道覆盖率达到 90% 才发布。请求失败、异常时间、冲突节目和空导出都会阻止发布；合法空节目单记录在清单中。

发布时先检查所有文件的校验和，再将新附件上传到临时名称；上传成功后替换公开名称，最后更新版本状态。替换失败会尝试恢复旧名称，原文件在完成切换前保留。GitHub 不支持多个附件原子切换，重命名期间可能有短暂下载间隙，客户端可重试。临时附件在成功后清理。新版本在文件上传完成前保持草稿状态。

同日期版本需要可修改附件，请**不要启用 Release immutability（版本不可变）**。若组织策略禁止工作流写仓库，需要允许发布作业的 `contents: write`；正常情况下使用自带的 `GITHUB_TOKEN`，无需额外 Secrets。Fork 后需启用 Actions，并修改本文订阅链接的仓库名。

## 播放器频道匹配

频道 ID 使用稳定的 `ysp.<央视频PID>`，`channel/@id` 与 `programme/@channel` 完全一致。例如 CCTV1 为 `ysp.600001859`，名称保持网站原名，常见 CCTV 频道还包含 `CCTV-1` 等显示别名。`channels.json` 同步提供 `aliases`，便于应用映射。支持按名称匹配的播放器可直接匹配；否则设置 M3U 的 `tvg-id`：

```m3u
#EXTM3U
#EXTINF:-1 tvg-id="ysp.600001859" tvg-name="CCTV1",CCTV1
https://your-stream-provider.example/cctv1.m3u8
```

播放地址为占位示例，本项目只提供节目单。

台标链接统一为真正的 PNG：移除源站将 PNG 转为 WebP 的 CDN 参数，并在每次抓取时通过无登录、无 Referer 的请求验证 PNG 文件签名。图片不内嵌到 XML，避免增加体积。XMLTV 字段、频道关联和跨日语义见 [接入说明](docs/xmltv.md)。

## 免费额度

本仓库是公开仓库，使用标准 `ubuntu-latest` 运行器，**Actions 运行时间免费**。私有仓库的 GitHub Free（包括免费组织）每月包含 **2,000 分钟**及 **500 MB Actions 构件存储**。Larger runners 即使在公开仓库也收费。本项目没有使用 Larger runners、Actions 构件或依赖缓存。[官方计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

Release 附件与 Actions 构件不同。单个 Release 附件需小于 2 GiB，每个 Release 最多 1,000 个附件，官方未限制 Release 总大小和带宽用量。[Release 限额](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas)

若一次运行的两个作业合计 5 分钟，每天一次、30 天约 150 分钟；实际以 Actions 耗时为准。公开仓库不消耗私有仓库的 2,000 分钟配额。

公开仓库 60 天无仓库活动时，定时工作流可能自动停用；不要假设自动运行或发布 Release 必然避免停用。若订阅长期未更新，请查看 Actions 并重新启用工作流。[官方 schedule 说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 本地运行

需要 Node.js 22 或更新版本；Actions 使用 Node.js 24。

```sh
npm ci
npm test
npm run generate
```

输出为 `dist/YYYY-MM-DD/epg.xml` 和对应元数据，`dist/releases.json` 列出本轮可发布的日期及每份 XML 的大小。不输出合并多天的大 XML，也不输出 Gzip。

```sh
npm run generate -- --past-days 1 --future-days 3 --concurrency 2 --output dist
npm run generate -- --date 2026-09-09 --past-days 0 --future-days 0
```

指定日期受源站保留范围约束；手动生成的历史数据不会被发布脚本误设为当天 Latest。其他参数见 `npm run generate -- --help`。正式发布建议保留默认覆盖率检查。

## 数据来源与验证

使用电视页实际请求的公开接口，无需运行浏览器：

1. `https://capi.yangshipin.cn/api/oms/pc/navigation/home_top_nav`：发现电视栏目。
2. `https://capi.yangshipin.cn/api/oms/pc/page/<feedId>`：发现频道及节目日期。
3. `https://capi.yangshipin.cn/api/yspepg/program/<pid>/<YYYYMMDD>`：获取节目单。

接口返回 Protocol Buffers，`src/yangshipin.proto` 的字段编号来自网站公开前端 schema，使用 protobufjs 解码，不执行远程 JavaScript。接口改版或网络限制可能需要调整适配器。

输出遵循 [XMLTV DTD](https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd)，使用显式 `+0800` 并保留秒级时间。离线测试覆盖真实响应快照、日期边界、XML 转义、去重、重试、并发、覆盖率、按日拆分、校验和、日期版本、Pre-release 晋升、覆盖更新和失败回滚。
