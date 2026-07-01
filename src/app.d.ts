// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	type PlaidSuccessMetadata = {
		institution?: {
			institution_id?: string;
			name?: string;
		};
	};

	type PlaidHandler = {
		open: () => void;
		exit: () => void;
	};

	type PlaidCreateConfig = {
		token: string;
		onSuccess: (publicToken: string, metadata: PlaidSuccessMetadata) => void;
		onExit?: (error: unknown) => void;
	};

	interface Window {
		Plaid?: {
			create: (config: PlaidCreateConfig) => PlaidHandler;
		};
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
