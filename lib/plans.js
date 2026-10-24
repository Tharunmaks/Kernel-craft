// Subscription plans. Prices are in paise (INR x 100) for Razorpay.
// Each paid plan is bought as 30 days of access; buying again extends it.

const PLANS = {
  free: {
    id: "free",
    name: "Free",
    pricePaise: 0,
    tagline: "Play with operating systems in your browser",
    targets: [],
    aiBuildsPerDay: 0,
    manualBuildsPerDay: 0,
    maxPasses: 0,
    bigFiles: 0,
    features: [
      "v86 browser emulator",
      "Boot the sample 16-bit and 32-bit OSes",
      "Upload and run your own .img files",
      "SDK documentation",
    ],
  },
  plus: {
    id: "plus",
    name: "Plus",
    pricePaise: 700_00,
    tagline: "AI builds 16-bit real-mode systems",
    targets: ["real16"],
    aiBuildsPerDay: 15,
    manualBuildsPerDay: 40,
    maxPasses: 3,
    bigFiles: 0,
    features: [
      "Everything in Free",
      "AI-built 16-bit OSes (bootloaders, shells, DOS-style systems)",
      "3 vision-checked repair passes per build",
      "Edit the code and rebuild",
      "Saved projects and .img export",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    pricePaise: 2000_00,
    tagline: "32-bit protected-mode desktops",
    targets: ["real16", "prot32"],
    aiBuildsPerDay: 40,
    manualBuildsPerDay: 100,
    maxPasses: 4,
    bigFiles: 10,
    features: [
      "Everything in Plus",
      "32-bit OSes on the KernelCraft SDK: windows, mouse, apps, filesystem",
      "Big-OS mode: an architect agent plans up to 10 files, writers build them in parallel",
      "4 repair passes per build",
    ],
  },
  max: {
    id: "max",
    name: "Max",
    pricePaise: 10000_00,
    tagline: "64-bit from scratch, or customise real Linux",
    targets: ["real16", "prot32", "long64", "linux64"],
    aiBuildsPerDay: 100,
    manualBuildsPerDay: 300,
    maxPasses: 5,
    bigFiles: 20,
    features: [
      "Everything in Pro",
      "64-bit long-mode OSes from scratch",
      "Linux Forge: AI customises a real 64-bit Linux (kernel + BusyBox + your programs)",
      "Big-OS mode with up to 20 AI-written files",
      "5 repair passes per build",
    ],
  },
};

const PLAN_ORDER = ["free", "plus", "pro", "max"];

function planFor(user) {
  if (!user) return PLANS.free;
  if (user.plan && user.plan !== "free" && user.planExpires && user.planExpires > Date.now()) return PLANS[user.plan] || PLANS.free;
  return PLANS.free;
}

// Cheapest plan that unlocks a target, for upgrade prompts.
function planForTarget(target) {
  return PLAN_ORDER.map((id) => PLANS[id]).find((p) => p.targets.includes(target));
}

function publicPlans() {
  return PLAN_ORDER.map((id) => {
    const { pricePaise, ...rest } = PLANS[id];
    return { ...rest, priceInr: pricePaise / 100 };
  });
}

module.exports = { PLANS, PLAN_ORDER, planFor, planForTarget, publicPlans };
