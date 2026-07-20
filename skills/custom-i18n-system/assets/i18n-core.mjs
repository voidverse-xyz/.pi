const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

function canonicalizeLocale(value) {
    if (typeof value !== "string" || value.trim().length === 0) return null;

    const candidate = value.trim().replaceAll("_", "-");
    try {
        return Intl.getCanonicalLocales(candidate)[0] ?? null;
    } catch {
        return null;
    }
}

function readPath(object, key) {
    return key.split(".").reduce((current, segment) => current?.[segment], object);
}

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function interpolate(template, params, report, locale, key) {
    return template.replace(PLACEHOLDER, (marker, name) => {
        const value = readPath(params, name);
        if (value === undefined || value === null) {
            report(`Missing interpolation value: locale=${locale}, key=${key}, placeholder=${name}`);
            return marker;
        }
        return String(value);
    });
}

function choosePlural(value, locale, params, report, key) {
    const count = Number(params.count);
    if (!Number.isFinite(count)) {
        report(`Plural message requires a finite count: locale=${locale}, key=${key}`);
        return null;
    }

    const exact = value[`=${count}`];
    if (typeof exact === "string") return exact;

    const category = new Intl.PluralRules(locale).select(count);
    const selected = value[category] ?? value.other;
    if (typeof selected !== "string") {
        report(`Plural message has no ${category} or other branch: locale=${locale}, key=${key}`);
        return null;
    }
    return selected;
}

/**
 * Create an isolated i18n instance. Catalog shape:
 * { id, name, dir: "ltr"|"rtl", locales?: string[], messages: object }
 */
export function createI18n({ catalogs, defaultLocale, onError = console.error }) {
    const source = Array.isArray(catalogs) ? catalogs : Object.values(catalogs ?? {});
    if (source.length === 0) throw new Error("At least one language catalog is required.");

    const report = (message) => onError?.(message);
    const byId = new Map();
    const aliases = new Map();

    for (const catalog of source) {
        if (!isRecord(catalog)) throw new Error("Every catalog must be an object.");

        const id = canonicalizeLocale(catalog.id);
        if (!id) throw new Error(`Invalid catalog id: ${catalog.id}`);
        if (byId.has(id)) throw new Error(`Duplicate catalog id: ${id}`);
        if (!catalog.name || !["ltr", "rtl"].includes(catalog.dir) || !isRecord(catalog.messages)) {
            throw new Error(`Catalog ${id} requires name, dir (ltr|rtl), and messages.`);
        }

        const normalized = { ...catalog, id };
        byId.set(id, normalized);
        aliases.set(id.toLowerCase(), id);

        for (const alias of catalog.locales ?? []) {
            const canonicalAlias = canonicalizeLocale(alias);
            if (!canonicalAlias) throw new Error(`Invalid locale alias in ${id}: ${alias}`);

            const existing = aliases.get(canonicalAlias.toLowerCase());
            if (existing && existing !== id) {
                throw new Error(`Locale alias ${canonicalAlias} is claimed by ${existing} and ${id}.`);
            }
            aliases.set(canonicalAlias.toLowerCase(), id);
        }
    }

    function resolveWithoutFallback(candidate) {
        const canonical = canonicalizeLocale(candidate);
        if (!canonical) return null;

        const exact = aliases.get(canonical.toLowerCase());
        if (exact) return exact;

        const base = canonical.split("-")[0];
        return aliases.get(base.toLowerCase()) ?? null;
    }

    const defaultId = resolveWithoutFallback(defaultLocale);
    if (!defaultId) throw new Error(`Default locale has no catalog: ${defaultLocale}`);

    function resolveLocale(...candidates) {
        for (const candidate of candidates.flat(Infinity)) {
            const resolved = resolveWithoutFallback(candidate);
            if (resolved) return resolved;
        }
        return defaultId;
    }

    function rawMessage(locale, key) {
        const resolved = resolveLocale(locale);
        let raw = readPath(byId.get(resolved).messages, key);

        if (raw === undefined && resolved !== defaultId) {
            report(`Missing translation; using fallback: locale=${resolved}, key=${key}`);
            raw = readPath(byId.get(defaultId).messages, key);
        }

        if (raw === undefined) report(`Missing translation key: locale=${resolved}, key=${key}`);
        return { raw, resolved };
    }

    function t(locale, key, params = {}) {
        const { raw, resolved } = rawMessage(locale, key);
        if (raw === undefined) return key;

        let template = raw;
        if (isRecord(raw)) template = choosePlural(raw, resolved, params, report, key);
        if (typeof template !== "string") {
            report(`Translation must be text or a plural map: locale=${resolved}, key=${key}`);
            return key;
        }

        return interpolate(template, params, report, resolved, key);
    }

    function listLanguages() {
        return [...byId.values()].map(({ id, name, dir, locales = [] }) => ({ id, name, dir, locales }));
    }

    function direction(locale) {
        return byId.get(resolveLocale(locale)).dir;
    }

    function formatNumber(locale, value, options) {
        return new Intl.NumberFormat(resolveLocale(locale), options).format(value);
    }

    function formatDate(locale, value, options) {
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) throw new TypeError("Invalid date value.");
        return new Intl.DateTimeFormat(resolveLocale(locale), options).format(date);
    }

    function formatList(locale, values, options) {
        return new Intl.ListFormat(resolveLocale(locale), options).format(values);
    }

    return Object.freeze({
        defaultLocale: defaultId,
        resolveLocale,
        listLanguages,
        direction,
        t,
        formatNumber,
        formatDate,
        formatList,
    });
}
