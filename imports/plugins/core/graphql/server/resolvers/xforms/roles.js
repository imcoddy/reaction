import { namespaces } from "@reactioncommerce/reaction-graphql-utils";
import { assocInternalId, assocOpaqueId, decodeOpaqueIdForNamespace, encodeOpaqueId } from "./id";

export const assocRolesInternalId = assocInternalId(namespaces.Role);
export const assocRolesOpaqueId = assocOpaqueId(namespaces.Role);
export const decodeRolesOpaqueId = decodeOpaqueIdForNamespace(namespaces.Role);
export const encodeRolesOpaqueId = encodeOpaqueId(namespaces.Role);