import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";

// Defense in depth for this test process, not a production OS/network sandbox.
export function guardNetwork(t) {
	let attempts = 0;
	const deny = () => { attempts++; throw new Error("Offline test blocked network access"); };
	const originals = [];
	const targets = [[globalThis, "fetch"], [net.Socket.prototype, "connect"], [tls, "connect"],
		[http, "request"], [http, "get"], [https, "request"], [https, "get"],
		[dgram.Socket.prototype, "connect"], [dgram.Socket.prototype, "send"]];
	for (const object of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
		for (const key of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname",
			"resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) {
			if (typeof object[key] === "function") targets.push([object, key]);
		}
	}
	for (const [object, key] of targets) {
		originals.push([object, key, object[key]]);
		object[key] = deny;
	}
	syncBuiltinESMExports();
	t.after(() => {
		for (const [object, key, original] of originals) object[key] = original;
		syncBuiltinESMExports();
		assert.equal(attempts, 0, "No forbidden network access was attempted");
	});
}
