# XMLTV 接入约定

订阅入口：`https://github.com/TvWasm/autoEPG/releases/latest/download/epg.xml`。
它是未压缩的 UTF-8 XML，仅包含与当天相交的节目。日期以北京时间为准。
未来数据使用日期版本的 `epg.xml`，例如 `/releases/download/2026-09-10/epg.xml`。

当天 Latest 另提供 `epg2.xml`（今天和明天）及 `epg3.xml`（今天、明天和后天），路径分别为 `/releases/latest/download/epg2.xml` 和 `/releases/latest/download/epg3.xml`。它们与单日文件使用相同频道 ID、PNG 台标和时间格式；合并后的每个节目只输出一次。

## 标准字段

| XMLTV 字段 | 约定 |
| --- | --- |
| `tv` | 标准根节点；所有 `channel` 在所有 `programme` 之前 |
| `channel/@id` | 不透明、稳定的频道 ID，例如 `ysp.600001859`；不要按显示名称猜测 ID |
| `channel/display-name` | 第一项为源站频道名称，后续为显示别名；不要将多个名称视为不同频道 |
| `channel/icon/@src` | 可直接请求的 PNG URL；不需要 Cookie 或 Referer |
| `channel/url` | 央视频对应频道页面，不是直播流 |
| `programme/@channel` | 引用已声明的 `channel/@id` |
| `programme/@start`、`@stop` | `YYYYMMDDhhmmss +0800`，包括秒及显式时区；结束时间为开区间 |
| `programme/title` | 保留源站标题并正确转义；包含汉字时标记 `lang="zh"`，其他标题省略无法确认的语言标记 |

示意（台标地址为占位示例）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="autoEPG">
  <channel id="ysp.600001859">
    <display-name lang="zh">CCTV1</display-name>
    <display-name lang="zh">CCTV-1</display-name>
    <icon src="https://example.com/cctv1.png"/>
  </channel>
  <programme start="20260909190000 +0800"
             stop="20260909194000 +0800" channel="ysp.600001859">
    <title lang="zh">新闻联播</title>
  </programme>
</tv>
```

## 时间与匹配

- 匹配频道时，优先让 M3U 的 `tvg-id` 等于 XML 的频道 ID。按名称匹配只能作为应用自己的回退策略。
- 时间已经带 `+0800`，解析为绝对时间后不要再额外加八小时。判断正在播放时使用 `start <= now < stop`。
- 跨午夜节目不会被截断或拆成假节目，可能出现在相邻日期的 XML 中。合并多天数据时用 `(channel, start)` 去重。
- 节目按频道 ID、开始时间排列。没有节目简介、类型、演员等源数据时省略这些可选字段，不生成猜测信息。
- 去除 XML 1.0 禁止的控制字符；标题里的 `&`、`<` 等由 XML 序列化器转义。程序需使用 XML 解析器，避免用正则表达式提取节目。

## 下载与刷新

支持 HTTPS 重定向并允许短暂失败重试。零点 Actions 需要执行时间，Latest 在当天数据完成校验、发布后切换；失败时保留最后成功版本。客户端可通过该版本的 `manifest.json` 中 `date`、`generatedAt` 判断新鲜度，不应仅凭 `latest` URL 假设一定已更新。

`channels.json` 中 `id`、`name`、`aliases`、`logo` 与 XML 一致，供壳应用建立映射；`pid`、`group`、`dates` 为附加源站信息。只读取 EPG 的应用无需解析 JSON。

格式依据：[XMLTV 官方 DTD](https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd)。ID 是 XMLTV 自由字符串，`ysp.` 前缀不是私有 XML 扩展。
