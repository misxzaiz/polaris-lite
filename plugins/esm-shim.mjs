// ESM shim：把 vite 预打包的 CJS react / react-dom 转成带命名导出的 ESM。
// 插件 bundle 用 `import ... from "react"` 命名导入；宿主 import map 指向本 shim。
//
// 关键：React 必须与主应用**同一实例**（否则插件组件 hooks 全部失效、渲染为空）。
// 主应用 main.tsx 挂载前把实例放到 window.__POLARIS_LITE_REACT__；本 shim 优先取它，
// 兜底再 import deps react（旧部署形态）。
//
// react-dom 同理：插件做 portal（弹层挂到 body，避免被槽位 overflow:hidden 裁剪）时，
// createPortal 必须与宿主同一实例，否则 portal 子树不共享 reconciler（hooks 失效）。
let ReactInstance = globalThis.__POLARIS_LITE_REACT__ ?? null;

if (!ReactInstance) {
  ReactInstance = (await import('/node_modules/.vite/deps/react.js')).default;
}

const {
  useState, useEffect, useRef, useCallback, useMemo, useContext, useReducer,
  useLayoutEffect, useId, useTransition, useDeferredValue, useSyncExternalStore,
  useImperativeHandle, useInsertionEffect, useDebugValue,
  createElement, cloneElement, isValidElement, Children, Component, PureComponent,
  Fragment, StrictMode, Suspense, lazy, memo, forwardRef, createRef, createContext,
  startTransition, version,
} = ReactInstance;

let ReactDOMInstance = globalThis.__POLARIS_LITE_REACT_DOM__ ?? null;
if (!ReactDOMInstance) {
  const mod = await import('/node_modules/.vite/deps/react-dom.js');
  ReactDOMInstance = mod.default ?? mod;
}

const createPortal = ReactDOMInstance?.createPortal;
const flushSync = ReactDOMInstance?.flushSync;
const findDOMNode = ReactDOMInstance?.findDOMNode;
// react-dom/client 的 createRoot/hydrateRoot：与宿主同一 reconciler 实例。
// 注意：vite 预打包的 react-dom.js（default）不含 createRoot；dev 下
// /node_modules/.vite/deps/* 由 dev server 以 HTML fallback 处理（拿不到 JS），
// 所以主应用把 react-dom/client 的命名导出预先放到
// globalThis.__POLARIS_LITE_REACT_DOM_CLIENT__（main.tsx bootstrap），这里只读它。
const clientApi = globalThis.__POLARIS_LITE_REACT_DOM_CLIENT__ ?? null;
const createRoot = clientApi?.createRoot;
const hydrateRoot = clientApi?.hydrateRoot;

export {
  useState, useEffect, useRef, useCallback, useMemo, useContext, useReducer,
  useLayoutEffect, useId, useTransition, useDeferredValue, useSyncExternalStore,
  useImperativeHandle, useInsertionEffect, useDebugValue,
  createElement, cloneElement, isValidElement, Children, Component, PureComponent,
  Fragment, StrictMode, Suspense, lazy, memo, forwardRef, createRef, createContext,
  startTransition, version,
  createPortal, flushSync, findDOMNode,
};
export default ReactInstance;

/** react-dom/client 命名导出（import map 'react-dom/client' 也指向本 shim） */
export { createRoot, hydrateRoot };
