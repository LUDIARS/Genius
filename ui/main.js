import { createAppController } from "./app-controller.js";

const root = document.getElementById("app");
if (root === null) throw new Error("UI root element #app is missing");

const controller = createAppController();
root.append(controller.element);
await controller.start();
