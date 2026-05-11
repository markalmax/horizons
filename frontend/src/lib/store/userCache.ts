import { writable } from 'svelte/store';
import { api } from '$lib/api';

interface UserCache {
	userName: string;
	referralCode: string;
	role: string;
	currentStreak: number;
	longestStreak: number;
	loaded: boolean;
}

const store = writable<UserCache>({
	userName: '',
	referralCode: '',
	role: '',
	currentStreak: 0,
	longestStreak: 0,
	loaded: false,
});

let fetchPromise: Promise<void> | null = null;

export const userStore = {
	subscribe: store.subscribe,
	async load() {
		// If already loaded, skip
		let current: UserCache | undefined;
		store.subscribe(v => current = v)();
		if (current?.loaded) return;

		// Deduplicate concurrent calls
		if (!fetchPromise) {
			fetchPromise = (async () => {
				const [userRes, referralRes] = await Promise.all([
					api.GET('/api/user/auth/me') as Promise<{ data?: Record<string, any> }>,
					api.GET('/api/user/auth/referral-code'),
				]);

				const slackDisplayName = userRes.data?.slackDisplayName as string | null | undefined;

				store.set({
					userName: slackDisplayName || 'you',
					referralCode: referralRes.data?.referralCode ?? '',
					role: (userRes.data?.role as string) ?? '',
					currentStreak: (userRes.data?.currentStreak as number) ?? 0,
					longestStreak: (userRes.data?.longestStreak as number) ?? 0,
					loaded: true,
				});
			})();
		}

		await fetchPromise;
	},
	// Triggers a server-side refresh against Hackatime for today's UTC bucket,
	// then patches the cached streak so the dashboard reflects in-progress
	// coding without a full page reload. Rate-limited server-side; safe to
	// fire-and-forget on every dashboard mount.
	async refreshStreak() {
		const res = await api.POST('/api/streaks/refresh', {});
		if (res.data) {
			store.update((s) => ({
				...s,
				currentStreak: res.data!.currentStreak,
				longestStreak: res.data!.longestStreak,
			}));
		}
	},
};
