import { createFileStore } from './file-store.mjs';
import { runStoreContract } from './store-contract.mjs';

runStoreContract('FileStore', createFileStore);
