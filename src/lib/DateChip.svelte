<script lang="ts">
	// Renders an ISO date (YYYY-MM-DD) as a compact calendar tile: a colored month band, the day
	// number, and the weekday. Parsed as local time so the day never shifts across a timezone.
	let { date }: { date: string } = $props();

	const parts = $derived.by(() => {
		const [year, monthNum, day] = date.split('-').map(Number);
		const value = new Date(year, monthNum - 1, day);
		return {
			weekday: new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(value),
			month: new Intl.DateTimeFormat('en-US', { month: 'short' }).format(value),
			day: String(day)
		};
	});
</script>

<span class="date-chip">
	<span class="date-chip-month">{parts.month}</span>
	<span class="date-chip-day">{parts.day}</span>
	<span class="date-chip-dow">{parts.weekday}</span>
</span>

<style>
	.date-chip {
		display: inline-flex;
		flex-direction: column;
		align-items: stretch;
		width: 3rem;
		overflow: hidden;
		text-align: center;
		line-height: 1;
		background: rgb(254 254 250 / 78%);
		border: 1px solid rgb(93 112 82 / 20%);
		border-radius: 0.7rem;
		box-shadow: 0 1px 2px rgb(60 66 54 / 8%);
	}

	.date-chip-month {
		padding: 0.22rem 0;
		color: var(--color-primary-foreground);
		background: var(--color-primary);
		font-size: 0.6rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.date-chip-day {
		padding: 0.26rem 0 0.06rem;
		font-family: var(--font-heading);
		font-size: 1.3rem;
		font-weight: 700;
		color: var(--color-foreground);
	}

	.date-chip-dow {
		padding: 0 0 0.24rem;
		color: var(--color-muted-foreground);
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}
</style>
