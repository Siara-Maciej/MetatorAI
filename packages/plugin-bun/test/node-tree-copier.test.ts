import { treeCopierContract } from "@metator/testing";
import { NodeTreeCopier } from "../src/node-tree-copier.ts";

treeCopierContract("NodeTreeCopier", () => new NodeTreeCopier());
