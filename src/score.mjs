/**
 * Scores are numbers from 0 to 1, or null for "no score".
 * - check score: what one check gave one run
 * - run score: the weighted mean of the run's check scores; an invalid run has none
 * - case score: the mean of the run scores over the reps, for one harness and one version
 * - suite score: the weighted mean of the case scores, for one harness and one version
 * @typedef {{ id: string, weight: number, minScore?: number, scores: Record<string, number | null> }} CaseScore
 * @typedef {{ harness: string, cases: CaseScore[], suite: Record<string, number | null> }} SuiteScore
 *   scores and suite are keyed by variant label
 */

// Absorbs float error in a mean, so three runs at 0.8 reach a bar of 0.8.
const EPSILON = 1e-9;

export const isUnitScore = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

export const formatScore = (score) => (score === null ? "n/a" : score.toFixed(2));

/**
 * @param {{ score: number | null, weight: number }[]} items
 * @returns {number | null} null when there is nothing to average or any item has no score
 */
export function weightedMean(items) {
	if (items.length === 0 || items.some((item) => item.score === null)) return null;
	const total = items.reduce((sum, item) => sum + item.weight, 0);
	return items.reduce((sum, item) => sum + item.score * item.weight, 0) / total;
}

const caseScore = (records) =>
	weightedMean(records.filter((record) => record.score !== null).map((record) => ({ score: record.score, weight: 1 })));

/** @returns {SuiteScore[]} one entry for each harness */
export function scoreSuites(harnessIds, cases, records, labels) {
	const perLabel = (score) => Object.fromEntries(labels.map((label) => [label, score(label)]));
	return harnessIds.map((harness) => {
		const scored = cases.map(({ id, weight, minScore }) => ({
			id,
			weight,
			minScore,
			scores: perLabel((label) => caseScore(records.filter((r) => r.harness === harness && r.caseId === id && r.variant === label))),
		}));
		return {
			harness,
			cases: scored,
			suite: perLabel((label) => weightedMean(scored.map((c) => ({ score: c.scores[label], weight: c.weight })))),
		};
	});
}

/**
 * The pass bars that the version under test did not reach. A missing score does not reach a bar.
 * @param {SuiteScore[]} suites
 * @returns {string[]}
 */
export function failedBars(suites, label, minScore) {
	const misses = (score, bar) => bar !== undefined && (score === null || score < bar - EPSILON);
	return suites.flatMap(({ harness, cases, suite }) => [
		...(misses(suite[label], minScore)
			? [`${harness}: suite score ${formatScore(suite[label])} does not reach --min-score ${formatScore(minScore)}`]
			: []),
		...cases
			.filter((c) => misses(c.scores[label], c.minScore))
			.map(
				(c) => `${harness}: case \`${c.id}\` score ${formatScore(c.scores[label])} does not reach its minScore ${formatScore(c.minScore)}`,
			),
	]);
}
