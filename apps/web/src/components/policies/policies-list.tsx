"use client";

import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { CardSkeleton } from "@/components/loading-skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EMPTY_STATES } from "@/config/emptyStates";
import { ROUTES, routeFor } from "@/config/navigation";
import { usePermission } from "@/hooks/use-current-user";
import {
  PolicyActionDialogs,
  PolicyMenu,
  usePolicyActionState,
  useToggleDefaultPolicy,
} from "./policy-actions";
import { PolicyCard } from "./policy-card";
import { comparePolicies, matchesPolicySearch } from "./policy-view-model";
import { usePolicies } from "./use-policies";

/** "Create policy" header button; hidden for roles without `policies:write`. */
export function CreatePolicyButton() {
  const canEdit = usePermission("policies:write");
  if (!canEdit) return null;
  return (
    <Button asChild>
      <Link href={ROUTES.policyNew}>
        <Plus aria-hidden="true" />
        Create policy
      </Link>
    </Button>
  );
}

function CreatePolicyLink({ label }: { label: string }) {
  return (
    <Button asChild>
      <Link href={ROUTES.policyNew}>{label}</Link>
    </Button>
  );
}

/**
 * `/policies`: every Work Policy as a card, with search, an archived toggle and the per-policy menu. Archived
 * policies come down with the rest (one request, no refetch on toggle) and are hidden client-side, so an
 * organisation whose only policies are archived can still reach them.
 */
export function PoliciesList() {
  const canEdit = usePermission("policies:write");
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const archivedId = useId();
  const policies = usePolicies({ includeArchived: true });
  const actions = usePolicyActionState();
  const toggleDefault = useToggleDefaultPolicy();

  if (policies.isPending) {
    return (
      <div
        className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        aria-busy="true"
        role="status"
        aria-label="Loading policies"
      >
        {Array.from({ length: 3 }, (_, i) => (
          <CardSkeleton key={i} lines={4} />
        ))}
      </div>
    );
  }
  if (policies.isError) {
    return (
      <ErrorState
        title="Couldn't load policies"
        error={policies.error}
        onRetry={() => void policies.refetch()}
        isRetrying={policies.isRefetching}
      />
    );
  }

  const all = [...policies.data].sort(comparePolicies);
  const archivedCount = all.filter((policy) => policy.status === "ARCHIVED").length;
  const visible = showArchived ? all : all.filter((policy) => policy.status !== "ARCHIVED");
  const copy = EMPTY_STATES.policies;

  if (all.length === 0) {
    return (
      <EmptyState
        icon={copy.icon}
        title={copy.title}
        description={copy.description}
        action={canEdit && copy.action ? <CreatePolicyLink label={copy.action.label} /> : undefined}
      />
    );
  }

  const filtered = visible.filter((policy) => matchesPolicySearch(policy, search));
  const archivedOnly = EMPTY_STATES.policiesAllArchived;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-72">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search policies…"
            aria-label="Search policies"
            className="h-9 pl-9"
          />
        </div>
        {archivedCount > 0 ? (
          <div className="flex items-center gap-2">
            <Switch id={archivedId} checked={showArchived} onCheckedChange={setShowArchived} />
            <Label htmlFor={archivedId} className="text-sm font-normal">
              Show archived ({archivedCount})
            </Label>
          </div>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={archivedOnly.icon}
          title={archivedOnly.title}
          description={archivedOnly.description}
          action={
            <Button type="button" variant="outline" onClick={() => setShowArchived(true)}>
              Show archived
            </Button>
          }
          secondaryAction={
            canEdit && archivedOnly.action ? (
              <CreatePolicyLink label={archivedOnly.action.label} />
            ) : undefined
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={EMPTY_STATES.search.icon}
          title={EMPTY_STATES.search.title}
          description={EMPTY_STATES.search.description}
          size="sm"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => setSearch("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Policies">
          {filtered.map((policy) => (
            <li key={policy.id} className="flex">
              <PolicyCard
                policy={policy}
                className="flex-1"
                actions={
                  <PolicyMenu
                    policy={policy}
                    canEdit={canEdit}
                    onAction={actions.open}
                    onToggleDefault={(target) => void toggleDefault.toggle(target)}
                    defaultPending={toggleDefault.isPending}
                  />
                }
              />
            </li>
          ))}
        </ul>
      )}

      <PolicyActionDialogs
        request={actions.request}
        onClose={actions.close}
        onDuplicated={(created) => router.push(routeFor.policy(created.id))}
      />
    </div>
  );
}
