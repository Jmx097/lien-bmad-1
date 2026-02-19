"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.limiter = void 0;
const bottleneck_1 = __importDefault(require("bottleneck"));
exports.limiter = new bottleneck_1.default({
    minTime: 1200,
    maxConcurrent: 1
});
