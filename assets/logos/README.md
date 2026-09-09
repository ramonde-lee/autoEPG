# CCTV 透明台标

本目录保存从 [wanglindl/TVlogo](https://github.com/wanglindl/TVlogo) 的 [CCTV 图集](https://github.com/wanglindl/TVlogo/blob/main/md/01.md) 下载的原始 PNG，下载日期为 2026-09-09。保留原始像素和透明通道，没有重新绘制、转码或放大。

33 张图片覆盖 34 个 CCTV 频道，包括 CCTV1–17、CCTV5+、CCTV4K、CCTV8K 和 13 个专业频道。CCTV16 高清与 4K 使用同一枚 CCTV16 奥林匹克台标，EPG 频道 ID 仍分别为 `cctv16`、`cctv164k`。CGTN 和卫视频道继续使用央视频源站台标。

台标采用银白渐变、透明背景，数字频道接近播出画面的玻璃质感。原图尺寸均为 300 × 180，可在深色和浅色背景上使用。每张图片的原始 URL、SHA-256、尺寸、大小及频道映射见 [sources.json](sources.json)。

| CCTV1 | CCTV3 | CCTV16 |
| --- | --- | --- |
| ![CCTV1](cctv1.png) | ![CCTV3](cctv3.png) | ![CCTV16](cctv16.png) |

EPG 和 `channels.json` 的台标地址指向本项目：

```text
https://raw.githubusercontent.com/TvWasm/autoEPG/main/assets/logos/cctv3.png
```

每次生成验证本地 PNG 签名和 SHA-256，运行时不依赖原图集。替换图片时同步更新 `sources.json` 的来源和校验和；文件路径与频道 ID 对应。Fork 的 Actions 使用 `GITHUB_REPOSITORY` 指向该 Fork 的图片。

## 来源声明

上游说明这些资源收集自网络，仅用于学习交流，商业使用需取得版权方同意。台标及商标权利归各自权利人所有；本项目保留来源说明，不将其声明为自行创作或公共领域素材。[上游声明](https://github.com/wanglindl/TVlogo#readme)
