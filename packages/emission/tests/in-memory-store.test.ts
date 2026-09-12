import { InMemoryEmissionStore } from './support/in-memory-store.js';
import { describeEmissionStoreContract } from './support/emission-store-contract.js';

describeEmissionStoreContract('memória', () =>
  Promise.resolve({
    store: new InMemoryEmissionStore(),
    tenantA: { tenantId: 'tenant-a', issuerId: 'issuer-a' },
    tenantB: { tenantId: 'tenant-b', issuerId: 'issuer-b' },
  }),
);
