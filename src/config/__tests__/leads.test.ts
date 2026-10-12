import { expect, it } from 'vitest'

import { jobScout } from '../jobs.js'
import { leadScout } from '../leads.js'

// Not a comparison of the two numbers — they may coincide. What must hold is that the leads
// pipeline reads a cap of its **own**, so tuning one cannot move the other. ADR-0039 exists
// because that was not true.

it('the scout has a bound at all (invariant 2)', () => {
  expect(Number.isInteger(leadScout.maxProfilesPerRun) && leadScout.maxProfilesPerRun > 0).toBe(true)
})

it("it is a different knob from the job scout's", () => {
  expect(Object.hasOwn(leadScout, 'maxProfilesPerRun') && !Object.hasOwn(jobScout, 'maxProfilesPerRun')).toBe(true)
})
