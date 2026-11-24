/**
 * voice-radio 服务端/前端共享常量（server.mjs 也能 import 的最小子集；
 * 完整类型与提示词在前端 core.ts，避免 server 半边引入 TS/JSX）。
 */

/** BGM 循环时长（秒）：服务端一次合成，前端 <audio> 循环播放 */
export const BGM_LOOP_SECONDS = 48;
