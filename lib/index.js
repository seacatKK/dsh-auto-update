/**
 * dsh-auto-update 宿主入口。
 *
 * 包 `exports["."]` 指向这里；真正的实现在 `./host.js`，
 * 拆开只是为了让“包入口”保持稳定，而路由/能力探测可以单独演进。
 * @module dsh-auto-update
 */
export { name, inject, apply, readProfileArg } from './host.js'
