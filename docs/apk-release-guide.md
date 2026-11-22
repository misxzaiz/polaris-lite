# polaris-lite Android APK 打包规范（apk-release-guide）

> 目的：把「手机 App 版」APK 的构建/签名/发版固化成可执行步骤。**任何人（含未来的 AI 会话）照本文档操作即可产出正确 APK**，不需要重新踩坑。
> 背景：docs/mobile-app-plan.md（手机 App 版方案 v2.2）。APK = Capacitor 壳包 polaris-lite 前端 + 手机侧原生能力；服务端仍在电脑（连接档）。

---

## 0. 环境一次性准备（已就绪，勿重复搭建）

| 项 | 位置/值 | 说明 |
|---|---|---|
| Android SDK | `D:\Android\Sdk` | build-tools 35.0.0（apksigner/aapt2/dexdump 在此） |
| **JDK 21** | `D:\Android\jdk-21\jdk-21.0.13+9` | **Capacitor 8 必须 Java 21**，JDK 17 会报「无效的源发行版：21」；从清华镜像下的 Temurin（github 直连超时） |
| 签名库 | `android-signing/plite-release.jks` | alias `plite`，store/key 密码均 `plite2026mobile`，SHA256 `7E:8C:67:4A:94:93:78:D6:95:9B:6A:53:7A:C9:01:CE:27:4F:AE:AE:97:DB:D5:B0:3B:D7:86:77:8C:D4:74:18`。**独立于 Polaris 主仓签名线；文件已 gitignore，勿入库勿外传** |
| 签名配置 | `android/plite-keystore.properties` | storeFile 用**绝对路径转义**写法（`D\:\\space\\...`）——相对路径基于 `android/` 目录解析，写 `../android-signing/...` 会找不到 |
| Node 依赖 | `@capacitor/cli` `@capacitor/core` `@capacitor/android` 均 8.6.2（devDependencies） | 已装 |

## 1. 构建步骤（顺序敏感，逐步执行）

```bash
cd D:\space\base\Polaris 之外的独立仓库 D:\space\base\polaris-lite

# ① 前端 + 插件产物（必须最先做——APK 封的是此刻的 dist 快照）
npm run build            # = typecheck + check:plugins + vite build + gen-sw-manifest
npm run build:plugins    # 重建 public/plugins/*（registry.json + 各插件 bundle）

# ② 把 dist 全量拷进 android 资产（cap sync 亦可，但 plugins 目录曾被旧态坑过——
#    用 fs-extra 直接 copy 最直观，见下）
node -e "const fs=require('fs-extra');(async()=>{await fs.copy('dist','android/app/src/main/assets/public');console.log('plugins:',fs.readdirSync('android/app/src/main/assets/public/plugins').length);})();"

# ③ Gradle 打包（必须走 cmd 脚本，见 §2 坑 1）
cd android
cmd //c build-apk.cmd

# ④ 产物落仓库根 + 验证
cp app/build/outputs/apk/release/app-release.apk ../plite-<版本>-release.apk
D:/Android/Sdk/build-tools/35.0.0/apksigner.bat verify ../plite-<版本>-release.apk   # 必须通过
```

产物命名：`plite-<semver>-release.apk`（如 `plite-0.2.0-release.apk`），落仓库根目录（已 gitignore）。

## 2. 已踩死的坑（每条都真实耗过时间，照做免重踩）

1. **Gradle 必须用 `android/build-apk.cmd`（cmd 脚本）执行**——在 Git Bash 里直接跑 `./gradlew`，MSYS 路径转换会把 wrapper 的 `-classpath` 打碎成 `D:/` 或 `""`，java 进程**空转假构建**（挂着不报错也不产 APK）。cmd 脚本内容：设 `JAVA_HOME=D:\Android\jdk-21\jdk-21.0.13+9` 后 `call gradlew.bat assembleRelease --no-daemon -q`。
2. **改完前端/插件必须完整走 ①→④**。APK 里的插件是**打包时快照**，不会从电脑热更新——真机 404 事故（registry fetch failed）就是打包时 dist/plugins 还是旧空态导致的。
3. **版本号两处同改**：`package.json` 的 `version` + `android/app/build.gradle` 的 `versionCode`（递增整数）/`versionName`（同 semver）。只改文件名不改 versionCode，Android 会把新包装成「同版本」，排查时无法区分。
4. **Capacitor 8 = Java 21**；`JAVA_HOME` 指向 17 时报「无效的源发行版：21」。
5. **APK 必须允许明文 HTTP**（`AndroidManifest.xml` 已加 `android:usesCleartextTraffic="true"`）——用户填的电脑地址是 `http://IP:端口`，targetSdk 36 默认禁明文，不加则真机 `ERR_CLEARTEXT_NOT_PERMITTED`。
6. **连接模型别动**（MainActivity）：APK 内嵌页运行在 `https://localhost` 壳源，壳里没有 Node 服务端——一切相对 `/api/*` 请求必须打到电脑。首次启动由引导层（index.html 内联脚本，仅 `https://localhost` 源渲染）收集地址，经 `plite://set-server?u=<addr>` 交 MainActivity 拦截，存 SharedPreferences 后 **WebView 直接 loadUrl 到电脑源**。切源时机必须在 **onResume**（bridge 就绪后）——onCreate 抢跑会 `ERR_CONNECTION_REFUSED`（localServer 尚未监听）。`capacitor.config.json` 的 `server.allowNavigation:["*"]` 不能删（否则切源后被甩给系统浏览器）。
7. **全屏（隐藏状态栏）用三通道叠加**（`hideStatusBar()`）：平台 `getInsetsController().hide(statusBars)` + 旧 `SYSTEM_UI_FLAG_FULLSCREEN` + 透明状态栏色。单通道在部分国产 ROM 上不响应（实测：仅 compat hide 无效）。onResume 每次重申。
8. **覆写 BridgeActivity 生命周期方法用 `public`**——父类是 public，写 protected 直接编译错「分配更低访问权限」。

## 3. 发版前检查清单

- [ ] `npm run typecheck` 0 错误；`npm test` 全绿
- [ ] `dist/plugins/` 非空且 registry.json 是最新（插件数与 `plugins/` 源目录一致）
- [ ] versionCode 比上一版**大**、versionName 与 package.json 一致
- [ ] `apksigner verify` 通过；`aapt2 dump badging` 显示正确包名/版本
- [ ] APK 内能 grep 到 `assets/public/plugins/registry.json`（插件真在包里）
- [ ] 真机卸载旧版后安装，走一遍：引导页填地址 → 登录 → 发消息 → 看面板

## 4. 快速排障

| 症状 | 根因（均实测过） |
|---|---|
| 手机上「插件加载失败 registry 404」 | 打包时 dist/plugins 是旧态 → 重跑 ①②④ |
| 登录报 `Unexpected token '<'`（HTML 非 JSON） | 页面跑在壳源，/api 打到壳自己 → 检查 MainActivity 切源逻辑与 allowNavigation |
| `https://localhost` ERR_CONNECTION_REFUSED | 切源抢在 localServer 启动前 → 确认切源在 onResume 而非 onCreate |
| `ERR_CLEARTEXT_NOT_PERMITTED` | 明文闸被关 → 确认 manifest 的 usesCleartextTraffic |
| gradle 挂着不动不产 APK | Git Bash 路径转换打碎 classpath → 用 build-apk.cmd |
| 编译错「无效的源发行版：21」 | JAVA_HOME 指到 17 → 用 D:\Android\jdk-21 |
| 状态栏还在 | 确认装的是最新 APK（对文件大小/版本号），且 hideStatusBar 三通道在源码里 |
