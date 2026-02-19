"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.humanDelay = humanDelay;
function humanDelay(min = 800, max = 1800) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}
