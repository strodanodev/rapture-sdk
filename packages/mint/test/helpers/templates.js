// Card templates that satisfy StudioMinter's and CardDesign's rules for their Kind (the same fixture the v1 suites
// build inline), and the 10-per-Kind pool shaped like ARC 1.
const { ethers } = require("hardhat");
const { STAT_MIN, STAT_MAX } = require("./deployStudio.js");

const KIND_NAMES = ["Mortal", "King", "Demigod", "Titan", "God"];

function template(kind, i) {
  const head = kind === 3 ? 0 : i % 4;
  const facet = kind === 0 ? 0 : i % 2;
  const circuit = i % 3;
  const bodyType = kind === 3 ? 0 : i % 2;
  const span = STAT_MAX[kind] - STAT_MIN[kind];
  const stat = (n) => STAT_MIN[kind] + ((i * 977 + n * 4051) % (span + 1));
  const divine = kind === 2 || kind === 4;
  return {
    kind,
    traits: {
      faction: i % 2,
      alignment: [0, 1, 2, 255][i % 4],
      element: i % 4,
      frame: (i >> 1) % 4,
      bodyparts: head | (facet << 8) | (circuit << 16) | (bodyType << 24),
      strength: stat(1), agility: stat(2), resilience: stat(3), intelligence: stat(4),
    },
    styleSource: { chainId: 0, collection: ethers.ZeroAddress, tokenId: 0 },
    design: {
      designHash: ethers.id(`design-${kind}-${i}`),
      art: ethers.id(`art-${kind}-${i}`),
      turntable: ethers.ZeroHash,
      overridesHash: ethers.ZeroHash,
      avatar: ethers.id(`avatar-${kind}-${i}`),
      avatarPlain: ethers.id(`plain-${kind}-${i}`),
      soul: ethers.id(`soul-${kind}-${i}`),
      kit: divine ? 1 + (i % 5) : 0,
      name: `${KIND_NAMES[kind]} Number ${i}`,
      epithet: `the ${KIND_NAMES[kind]}`,
    },
  };
}

const POOL = [0, 1, 2, 3, 4].flatMap((k) => Array.from({ length: 10 }, (_, i) => template(k, i)));

module.exports = { template, POOL, KIND_NAMES };
