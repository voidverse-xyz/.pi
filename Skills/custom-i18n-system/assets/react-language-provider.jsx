import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export const LanguageContext = createContext(null);

function browserCandidates(storageKey) {
    if (typeof window === "undefined") return [];

    let stored = null;
    try {
        stored = window.localStorage.getItem(storageKey);
    } catch {
        // Storage can be unavailable in private/sandboxed browser contexts.
    }

    return [stored, ...(window.navigator.languages ?? []), window.navigator.language].filter(Boolean);
}

/**
 * Pass a server/session-resolved userLocale during SSR to avoid hydration differences.
 * onLocaleChange is called only for an explicit user selection, not initial resolution.
 */
export function LanguageProvider({
    i18n,
    userLocale,
    storageKey = "locale",
    onLocaleChange,
    onPersistError = console.error,
    children,
}) {
    const [locale, setLocale] = useState(() => i18n.resolveLocale(userLocale, browserCandidates(storageKey)));

    // A persisted account/session preference always wins when it arrives or changes.
    useEffect(() => {
        if (userLocale) setLocale(i18n.resolveLocale(userLocale));
    }, [i18n, userLocale]);

    useEffect(() => {
        if (typeof document === "undefined") return;
        document.documentElement.lang = locale;
        document.documentElement.dir = i18n.direction(locale);
    }, [i18n, locale]);

    const selectLocale = useCallback(
        async (candidate) => {
            const resolved = i18n.resolveLocale(candidate);
            setLocale(resolved);

            try {
                window.localStorage.setItem(storageKey, resolved);
            } catch (error) {
                onPersistError?.(error);
            }

            await onLocaleChange?.(resolved);
            return resolved;
        },
        [i18n, onLocaleChange, onPersistError, storageKey],
    );

    const value = useMemo(
        () => ({
            locale,
            dir: i18n.direction(locale),
            languages: i18n.listLanguages(),
            selectLocale,
            t: (key, params) => i18n.t(locale, key, params),
            formatNumber: (number, options) => i18n.formatNumber(locale, number, options),
            formatDate: (date, options) => i18n.formatDate(locale, date, options),
            formatList: (items, options) => i18n.formatList(locale, items, options),
        }),
        [i18n, locale, selectLocale],
    );

    return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
    const value = useContext(LanguageContext);
    if (!value) throw new Error("useLanguage must be used inside LanguageProvider.");
    return value;
}
