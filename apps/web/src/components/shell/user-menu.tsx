"use client";

import { Building, KeyRound, LifeBuoy, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROUTES } from "@/config/navigation";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { useLogout, useSwitchOrganisation } from "@/hooks/use-auth";
import type { CurrentUser } from "@/hooks/use-current-user";
import { getInitials } from "@/lib/format";
import { ChangePasswordDialog } from "./change-password-dialog";
import { ThemeMenuItems } from "./theme-toggle";

/**
 * Avatar menu: identity, organisation switching (small screens, where the top-bar switcher is hidden), theme,
 * change password, settings/help links and sign out.
 */
export function UserMenu({ me }: { me: CurrentUser }) {
  const { user } = me;
  const logout = useLogout();
  const [passwordOpen, setPasswordOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label={`Account menu for ${user.name}`}
          >
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                {getInitials(user.name)}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="font-normal">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="text-muted-foreground truncate text-xs">{user.email}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {me.organisations.length > 1 ? <MobileOrganisationSwitcher me={me} /> : null}
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => setPasswordOpen(true)}>
              <KeyRound aria-hidden="true" />
              Change password
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={ROUTES.settings}>
                <Settings aria-hidden="true" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={ROUTES.help}>
                <LifeBuoy aria-hidden="true" />
                Help
              </Link>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <ThemeMenuItems />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={logout.isPending}
            onSelect={() => logout.mutate()}
          >
            <LogOut aria-hidden="true" />
            {logout.isPending ? "Signing out…" : "Sign out"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </>
  );
}

function MobileOrganisationSwitcher({ me }: { me: CurrentUser }) {
  const switchOrganisation = useSwitchOrganisation();
  const toastError = useApiErrorToast();
  const currentId = me.currentOrganisationId ?? me.organisations[0]?.id ?? "";
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="sm:hidden">
        <Building aria-hidden="true" />
        Switch organisation
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <DropdownMenuRadioGroup
          value={currentId}
          onValueChange={(organisationId) => {
            if (organisationId === currentId) return;
            switchOrganisation.mutate(organisationId, {
              onError: (error) => toastError(error, { title: "Couldn't switch organisation" }),
            });
          }}
        >
          {me.organisations.map((org) => (
            <DropdownMenuRadioItem
              key={org.id}
              value={org.id}
              disabled={switchOrganisation.isPending}
            >
              <span className="truncate">{org.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
