"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { NAV_SECTIONS, ROUTES, getActiveNavItem } from "@/config/navigation";
import { SITE } from "@/config/site";

/**
 * Primary navigation. Collapses to icons on desktop (⌘/Ctrl+B or the rail), becomes a sheet on mobile and
 * closes itself after navigating there.
 */
export function SidebarNav({ organisationName }: { organisationName: string | null }) {
  const pathname = usePathname();
  const active = getActiveNavItem(pathname);
  const { isMobile, setOpenMobile } = useSidebar();

  const onNavigate = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-sidebar-border border-b">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip={SITE.name}>
              <Link href={ROUTES.overview} onClick={onNavigate}>
                <BrandMark className="size-8" />
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate font-semibold">{SITE.name}</span>
                  {organisationName ? (
                    <span className="text-sidebar-foreground/70 truncate text-xs">
                      {organisationName}
                    </span>
                  ) : null}
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main">
          {NAV_SECTIONS.map((section) => (
            <SidebarGroup key={section.id}>
              <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((item) => {
                    const isActive = active?.href === item.href;
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
                          <Link
                            href={item.href}
                            aria-current={isActive ? "page" : undefined}
                            onClick={onNavigate}
                          >
                            <item.icon aria-hidden="true" />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <p className="text-sidebar-foreground/70 px-2 pb-1 text-xs leading-relaxed">
          {SITE.privacyLine}
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
