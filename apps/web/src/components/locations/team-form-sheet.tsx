"use client";

import type { Team } from "@workmode/validation/locationsTeams";
import { toast } from "sonner";
import { ReferenceSelectField } from "@/components/employees/reference-select";
import { FormErrorAlert, SubmitButton, TextField, applyApiFieldErrors, useZodForm } from "@/components/forms/form-fields";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  EMPTY_TEAM_FORM,
  compareByName,
  teamFormSchema,
  teamToFormValues,
  toCreateTeamInput,
  toUpdateTeamInput,
  type TeamFormValues,
} from "./locations-view-model";
import { useCreateTeam, useLocationsList, useUpdateTeam } from "./use-locations-teams";

export interface TeamFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this team; omit to create a new one. */
  team?: Team | null;
  onSaved?: (team: Team, mode: "create" | "edit") => void;
}

/** Add / Edit team drawer: `POST /api/teams` or `PATCH /api/teams/:id` (changed fields only). Members are managed separately. */
export function TeamFormSheet({ open, onOpenChange, team = null, onSaved }: TeamFormSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        {open ? <TeamForm key={team?.id ?? "new"} team={team} onClose={() => onOpenChange(false)} onSaved={onSaved} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function TeamForm({ team, onClose, onSaved }: { team: Team | null; onClose: () => void; onSaved?: TeamFormSheetProps["onSaved"] }) {
  const mode = team ? "edit" : "create";
  const form = useZodForm(teamFormSchema, { defaultValues: team ? teamToFormValues(team) : EMPTY_TEAM_FORM });
  const create = useCreateTeam();
  const update = useUpdateTeam();
  const locations = useLocationsList();
  const isPending = create.isPending || update.isPending;

  const onSubmit = form.handleSubmit(async (values: TeamFormValues) => {
    try {
      if (team) {
        const input = toUpdateTeamInput(values, team);
        if (!input) {
          toast.info("No changes to save");
          onClose();
          return;
        }
        const saved = await update.mutateAsync({ id: team.id, input });
        toast.success(`${saved.name} updated`);
        onClose();
        onSaved?.(saved, "edit");
      } else {
        const saved = await create.mutateAsync(toCreateTeamInput(values));
        toast.success(`${saved.name} added`, { description: "Add members so the team's policies apply to them." });
        onClose();
        onSaved?.(saved, "create");
      }
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  const locationOptions = locations.data ? [...locations.data].sort(compareByName).map((location) => ({ id: location.id, name: location.name })) : undefined;

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{mode === "edit" ? `Edit ${team!.name}` : "Add team"}</SheetTitle>
          <SheetDescription>
            {mode === "edit"
              ? "Renaming or moving a team doesn't change its members or assignments."
              : "A group of employees that can share a Work Policy and Break Rules."}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <FormErrorAlert error={create.error ?? update.error} title={mode === "edit" ? "Couldn't save changes" : "Couldn't add the team"} />
          <TextField control={form.control} name="name" label="Name" placeholder="e.g. Front of house" autoComplete="off" autoFocus={mode === "create"} />
          <ReferenceSelectField
            control={form.control}
            name="locationId"
            label="Location"
            description="Optional. Helps you find the team and shows where its members work."
            options={locationOptions}
            isLoading={locations.isPending}
            noneLabel="No location"
            placeholder="Choose a location"
          />
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <SubmitButton isPending={isPending} pendingLabel="Saving…">
            {mode === "edit" ? "Save changes" : "Add team"}
          </SubmitButton>
        </SheetFooter>
      </form>
    </Form>
  );
}
