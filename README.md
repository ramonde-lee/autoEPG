# autoEPG

自动获取[央视频电视页](https://www.yangshipin.cn/tv/home)节目单，生成标准 **XMLTV EPG**，通过 GitHub Release 提供固定订阅地址。定时任务在 GitHub Actions 上执行，无需部署服务器、登录央视频或配置个人访问令牌。

## 订阅地址

首次工作流成功发布后可用，后续更新无需修改地址：

| 文件 | 固定地址 |
| --- | --- |
| XMLTV | [epg.xml](https://github.com/TvWasm/autoEPG/releases/latest/download/epg.xml) |
| Gzip 压缩版（推荐） | [epg.xml.gz](https://github.com/TvWasm/autoEPG/releases/latest/download/epg.xml.gz) |
| 频道 ID、名称、台标、源站可用日期 | [channels.json](https://github.com/TvWasm/autoEPG/releases/latest/download/channels.json) |
| 更新时间、覆盖范围、空节目单记录 | [manifest.json](https://github.com/TvWasm/autoEPG/releases/latest/download/manifest.json) |
| SHA-256 校验和 | [SHA256SUMS](https://github.com/TvWasm/autoEPG/releases/latest/download/SHA256SUMS) |

在 IPTV 播放器中填写 XML 或 Gzip 地址。客户端需要支持 HTTPS 重定向；不支持 Gzip 时使用 XML。

频道使用稳定 ID `ysp.<央视频PID>`，名称与网站一致，同时为常见 CCTV 频道添加 `CCTV-1` 等显示名称。播放器支持按名称匹配时可以直接匹配；否则请根据 `channels.json` 设置播放列表的 `tvg-id`，例如：

```m3u
#EXTM3U
#EXTINF:-1 tvg-id="ysp.600001859" tvg-name="CCTV1",CCTV1
https://your-stream-provider.example/cctv1.m3u8
```

上面播放地址只是占位示例。本项目提供节目单，不提供直播流。

## 自动更新

工作流：[Update EPG](https://github.com/TvWasm/autoEPG/actions/workflows/epg.yml)。

- 每天北京时间 **00:23、06:23、12:23、18:23** 更新。
- 推送到 `main` 后自动测试并发布；PR 仅测试。
- 可以在 Actions → Update EPG → Run workflow 手动执行。
- 默认导出过去 3 天、今天、未来 3 天，以源站实际公布的日期为准。另外抓取前一日来保留跨入起始日的节目，节目起止时间不会被午夜截断。
- 自动发现网站频道，4 个并发请求，每个请求最多尝试 3 次。无需维护硬编码频道清单。
- 生成 `epg.xml` 和 `epg.xml.gz`，时间明确写为 `+0800`，保留源站的秒级时间。

每次成功生成一个独立 Release。先上传全部文件到草稿，再发布并设为 Latest，因此抓取失败或上传中断不会替换现有 Latest。历史 Release 保留，可手动清理旧版本；上传失败的草稿也可手动删除。`latest/download` 始终指向最近一次成功发布；请避免把不含 EPG 文件的其他 Release 设为 Latest。

默认至少发现 50 个频道、至少 90% 频道有今天的节目才允许发布；任何请求耗尽重试、响应解析失败、异常时间、冲突节目、空导出都会使任务失败。合法的空节目单记录在 `manifest.json` 中，不填充虚构节目，也不拼接过期缓存冒充新数据。少量源站缺失仍可能通过 90% 阈值，实际覆盖率和缺失频道也会写入清单。

## 启用与费用

本仓库为公开仓库，使用标准 `ubuntu-latest` 运行器。GitHub Actions 的标准运行器在公开仓库上免费；私有仓库的 GitHub Free（包括免费组织）每月包含 **2,000 分钟**和 **500 MB Actions 构件存储**。Larger runners 即使在公开仓库中也收费。本项目使用 Release 附件分发，没有上传 Actions 构件或启用依赖缓存。[官方计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

Release 附件与 Actions 构件不同。GitHub 官方规定单附件小于 2 GiB，单 Release 最多 1,000 个附件，没有 Release 总大小或带宽用量限制。[Release 限额](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas)

以每天 4 次、每次合计 3 分钟估算，一个 30 天月约 360 分钟；这是估算，实际以 Actions 的两个作业耗时为准。公开仓库不受私有仓库这 2,000 分钟额度约束。

工作流通过自带的 `GITHUB_TOKEN` 发布，只给发布作业 `contents: write` 权限，无需额外 Secrets。如果组织策略禁止工作流写入仓库，需要管理员允许相应权限。Fork 后请在自己的仓库启用 Actions，并替换本文订阅链接中的仓库名。

GitHub 定时任务可能延迟；公开仓库 **60 天没有仓库活动时，定时工作流可能被自动停用**。若发现订阅长期未更新，请查看 Actions 并重新启用工作流，不应假设自动运行或 Release 发布必然能避免停用。[官方 schedule 说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 本地运行

需要 Node.js 22 或更新版本；GitHub Actions 使用 Node.js 24。

```sh
npm ci
npm test
npm run generate
```

输出到 `dist/`。自定义示例：

```sh
npm run generate -- --past-days 1 --future-days 3 --concurrency 2 --output dist
npm run generate -- --date 2026-09-09 --past-days 0 --future-days 0
```

指定日期仍受源站保留范围约束，不提供任意历史日期查询。其他参数可通过 `npm run generate -- --help` 查看；小规模调试可以调整 `--min-channels` 和 `--min-today-coverage`，正式发布建议保留默认检查。

## 数据来源与验证

脚本使用电视页自身请求的公开接口：

1. `https://capi.yangshipin.cn/api/oms/pc/navigation/home_top_nav`：查找电视栏目。
2. `https://capi.yangshipin.cn/api/oms/pc/page/<feedId>`：动态发现频道及节目日期。
3. `https://capi.yangshipin.cn/api/yspepg/program/<pid>/<YYYYMMDD>`：获取对应频道日期的节目单。

这些接口返回 Protocol Buffers。`src/yangshipin.proto` 只声明所需字段，字段编号来自网站公开的前端 schema，使用 protobufjs 解码；不执行远程 JavaScript。接口不是本项目控制的稳定服务，若网站改版或限制 GitHub 运行器访问，需要调整适配器。网站在浏览器中能访问并不能保证所有 GitHub 运行器也能访问。

测试包含网站真实响应快照、北京时间/跨年/跨日边界、XML 转义、去重、重试、并发限制、覆盖率门槛、Gzip 和校验和验证。测试无需网络。XML 结构遵循 [XMLTV DTD](https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd)：先输出所有频道，再输出带频道引用、开始/结束时间和标题的节目。
