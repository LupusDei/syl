# Scaling laws

**Source**: Veritasium, *Why Every Mammal Gets 1 Billion Heartbeats*, based on
Geoffrey West's *Scale* (2017).
`~/code/ai/transcripts/veritasium-why-every-mammal-gets-1-billion-heartbeats.txt`
**Ingested**: 2026-08-09 by tassadar. Numbers in `scaling-laws.json`.

---

## The one-sentence version

Heart rate falls as M^(-1/4) and lifespan rises as M^(+1/4), so their product —
total heartbeats in a life — is mass-invariant at roughly **one billion**, for a
1.8 gram shrew and a 6 tonne elephant alike.

## Why this is in Syl's knowledge folder

Three reasons, in ascending order of usefulness.

1. **It is a good story with real numbers behind it**, and the Commander asked
   for the ratios kept.
2. **It is a reusable reasoning move.** Almost every estimate anyone makes by
   "scaling up" assumes linearity. Linearity is the special case, not the
   default. The habit of asking *what exponent is this actually?* is worth more
   than any single constant in the file.
3. **It is a worked example of how to hold a contested fact.** The famous number
   here — Kleiber's 3/4 — is not settled, and most sources repeat it as if it
   were. The entry records the dispute alongside the claim. That is the pattern
   every later entry should follow.

---

## The argument, in order

### Linearity kills

In 1962, MK Ultra researchers wanted to give LSD to an elephant. They knew the
safe cat dose: 0.3 mg. An elephant is ~1000x a cat's mass, so they gave 1000x
the dose — nearly 300 mg. Tusko trumpeted, collapsed, went into status
epilepticus, and died within minutes.

The error was not carelessness. It was a *model*: that safe dose is proportional
to mass. Drug clearance tracks **metabolic rate**, and metabolic rate is not
proportional to mass.

| exponent | dose for Tusko |
| -------- | -------------- |
| 1 (linear, what they used) | 300 mg |
| 2/3 (surface law) | 30 mg |
| 3/4 (Kleiber) | **53 mg** |

They gave him about six times the defensible dose.

### Why not linear: the heat argument

Cells are the same size and do the same job in every mammal. So an elephant with
1000x the mass has ~1000x the cells and should burn ~1000x the energy —
250,000 kcal/day against a cat's 250.

But energy burned leaves as heat, through the skin. Volume goes as r³ while
surface goes as r². Ten times the radius is 1000x the volume and only 100x the
surface. An animal generating 1000x the heat with 100x the radiating area
cooks itself.

So in 1838 French scientists proposed that metabolic rate must track **surface
area**: B ∝ A ∝ r², and since M ∝ r³, that gives **B ∝ M^(2/3)**.

*(The same argument, in a kitchen: cooking time goes as thickness², mass as
length³, so time ∝ M^(2/3). Double the roast and cook it ~60% longer, not
twice as long.)*

### Kleiber measured it and got a different number

In 1932 Max Kleiber plotted metabolic rate against mass, from a 150 g dove to a
680 kg steer, on log-log axes. Straight line — but the slope was **3/4**, not
2/3.

Double an animal's mass and metabolism rises 68%, not 59%. Small difference in
exponent, large difference over three orders of magnitude: it moves Tusko's
dose from 30 mg to 53 mg, and the elephant's daily budget from 25,000 to 45,000
kcal.

Big is efficient. An organism 100x larger needs only 31.6x the energy. Nobody
fully agrees why.

### The quarter-power family

The strange part is not 3/4. It is that *everything* lands on a multiple of a
quarter:

- **M^(3/4)** — metabolic rate, brain size, growth rate, blood pumped per minute
- **M^(1/4)** — lifespan, blood circulation time
- **M^(-1/4)** — heart rate, breathing rate
- **M^1** — blood volume per heartbeat

A regularity that clean across unrelated traits is asking for a mechanism.

### WBE theory: the fourth dimension of life

West, Brown and Enquist (Santa Fe Institute, 1997) proposed one, from three
premises:

1. Distribution networks are **space-filling** — every cell must be reached.
2. **Terminal units are invariant** — a capillary in an elephant is about as
   wide as one in a mouse. The elephant just has more.
3. Evolution has **optimised** the network for energy.

From those: branching beats parallel straight runs (less material); preserving
cross-sectional area across a junction minimises back-reflection of blood. The
result is a self-similar fractal — which is what a real circulatory system looks
like.

Then the trick. Hausdorff showed a sufficiently crumpled surface has dimension
approaching 3 rather than 2 — fold a sheet of paper enough and it fills a ball.
The exchange surface of the circulatory network is crumpled like that, so its
area scales as L³, not L². Volume = area × length ∝ L⁴, and volume ∝ mass, so

> **L ∝ M^(1/4)** — life is effectively four-dimensional: three spatial, one fractal.

Feed that back in and B ∝ M^(3/4). Kleiber's exponent, derived.

### Why the theory is taken seriously

It doesn't fit one number. West's table makes **26** predictions, including
awkward ones — aorta radius M^(3/8) = 0.375 (measured 0.36), lung area M^(11/12)
= 0.92 (measured 0.95). It sticks its neck out and the data mostly agree.

### The billion

Heart rate = blood flow / volume per beat = M^(3/4) / M^1 = **M^(-1/4)**.

Lifespan: if ageing is accumulated metabolic damage, damage rate is metabolic
rate per unit mass = M^(3/4)/M = M^(-1/4), and lifespan is its inverse =
**M^(1/4)**.

Multiply: **M^0**. A constant.

- Etruscan shrew: 1200 bpm × 1.5 years ≈ 950 million
- African elephant: 30 bpm × 65 years ≈ 1.03 billion

Live fast and die young, or spend it slowly and live long. Same allowance.

---

## The exception is us

Humans get **~3 billion**. Three centuries ago we were near 1 billion like
everyone else. Germ theory and sanitation from the mid-1800s cut child mortality
and infectious death, and life expectancy climbed — with visible dips for the
1918 flu and the Second World War.

Science bought the average human more than a full extra life. In years, we now
live like a mammal somewhere between an elephant and a whale.

Other mammals show the same effect in captivity, away from wild hazards. So this
is not a human-biology exception; it is a *hazard* exception. The allometry
describes the machine, not the environment it runs in.

## Cities scale too

Same method — log-log, read the slope. Two regimes:

**Sublinear ≈ 0.85** — infrastructure. Roads, cables, gas stations. Double the
city, add only ~74-80% more. Shared things get cheaper per person, which makes
dense cities plausibly *greener* than spread-out living.

**Superlinear ≈ 1.15** — wages, GDP, patents. Double the city, get ~120% more.
Increasing returns to being together.

And the sting: **crime, waste water and disease sit on the same superlinear
slope**. A city 100x a 50,000-person town needs ~50x the infrastructure and
produces ~200x the output — and ~200x the crime. Per person: half the
infrastructure, double the output, double the harm. The upside and the downside
share an exponent.

The 1889 doctor complaining of "the poisonous germs and pollutions of the city"
was measuring something real. So were the people who moved there anyway.

Pace of life scales too: people demonstrably walk faster in bigger cities.

**Open problem**: unlike biology, there is no accepted theory of *why* the city
exponents are 0.85 and 1.15. Explaining them is a live goal.

---

## What is actually disputed

This is the part most retellings drop.

- Kleiber's dataset was small and mammal-heavy.
- A 391-species study fits 3/4 only at the **large** end. Zoom out and smaller
  mammals track closer to **2/3**. Recent bird data also leans 2/3.
- Metabolic rate is brutally hard to measure — the animal must be resting and
  unstressed while you measure heat or O₂ precisely, which is nearly impossible
  in large animals. Many studies produce error bars spanning both 2/3 and 3/4.
- At a 1960s symposium the field voted **29-0** for 3/4. Some of that number's
  authority is convention.
- Peter Dodds (Vermont): the analysis is wrong or the data too noisy to bear it.
- Against 2/3: cold-blooded-animal studies come in well above it.

**Where it stands**: the community is split, and a growing group suspects there
is no universal exponent at all — perhaps 2/3 for small mammals and 3/4 for
large. And fitting the right exponents wouldn't prove WBE's mechanism anyway;
rival theories reproduce some of the same numbers.

The honest summary is a methodological one: *nobody has redone the
measurements properly.* One elephant at one zoo is not a dataset.

---

## Keep these five

1. Power law ⇒ straight line on log-log, and the slope **is** the exponent.
   <1 sublinear, >1 superlinear, =1 the naive default that is usually wrong.
2. Find a power law, look for self-similarity. The exponent is a network
   property.
3. Equal and opposite exponents make an invariant, and the invariant is usually
   the interesting quantity.
4. Sometimes things punch above their weight. Being big is often a bargain —
   in animals and in cities.
5. Before extrapolating across orders of magnitude, ask what the quantity is
   really limited by. Tusko died of a units error dressed as arithmetic.
