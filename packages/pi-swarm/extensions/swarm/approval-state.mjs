import { requireCondition as check } from "./errors.mjs";
import { providerAgreements } from "./model-settings.mjs";
import { validateProviderDescriptor } from "./provider-capability.mjs";

export function validateApproval(approval, expectedAction, existing = []) {
	const fields = ["action", "existingChanges", "id", "specificationFingerprint", "workspaceFingerprint"];
	if (approval?.provider !== undefined) fields.push("provider");
	if (approval?.providers !== undefined) fields.push("providers");
	check(approval && Object.keys(approval).sort().join() === fields.sort().join(), "INPUT", "Invalid approval record");
	if (approval.provider !== undefined) validateProviderDescriptor(approval.provider);
	if (approval.providers !== undefined) {
		check(Array.isArray(approval.providers), "PROVIDER", "Invalid provider agreements");
		const identities = new Set();
		for (const descriptor of approval.providers) {
			validateProviderDescriptor(descriptor);
			const identity = JSON.stringify([descriptor.provider, descriptor.modelId]);
			check(!identities.has(identity), "PROVIDER", "Duplicate provider agreement");
			identities.add(identity);
		}
		if (approval.provider) check(approval.providers.some(descriptor => sameDescriptor(approval.provider, descriptor)), "PROVIDER", "Primary provider must appear in provider agreements");
	}
	if (expectedAction !== "configure") {
		const prior = existing.at(-1);
		if (prior?.provider) check(approval.provider && sameDescriptor(prior.provider, approval.provider), "PROVIDER", "Continuation cannot remove or replace the provider agreement");
		const previous = providerAgreements(prior);
		const current = providerAgreements(approval);
		check(previous.every(descriptor => current.some(candidate => sameDescriptor(descriptor, candidate))), "PROVIDER", "Continuation cannot remove or replace provider agreements");
	}
	check(typeof approval.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(approval.id) && !existing.some(item => item.id === approval.id), "DUPLICATE", "Invalid or reused approval identifier");
	check(approval.action === expectedAction && ["launch", "resume", "restart", "configure"].includes(expectedAction), "AUTHORITY", "Approval does not match requested action");
	check(["clean", "preserve"].includes(approval.existingChanges), "AUTHORITY", "Existing-work preservation record required");
	for (const name of ["workspaceFingerprint", "specificationFingerprint"]) check(typeof approval[name] === "string" && /^[a-f0-9]{64}$/.test(approval[name]), "INPUT", "Invalid approval fingerprint");
}

function sameDescriptor(previous, current) {
	return Object.keys(previous).every(key => JSON.stringify(previous[key]) === JSON.stringify(current[key]));
}
