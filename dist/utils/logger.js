"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
function log(event) {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        ...event
    }));
}
