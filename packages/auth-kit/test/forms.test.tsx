// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthForms } from "../src/react/forms.js";
import type { AuthClient } from "../src/react/client.js";

afterEach(cleanup);

describe("email password form", () => {
  it("submits a email as loginId while keeping SMS phone-only", async () => {
    const client: AuthClient = {
      captcha: vi.fn().mockResolvedValue({ id: "captcha-identifier", image: "<svg/>", expiresAt: Date.now() + 120000, serverTime: Date.now() }),
      signInPassword: vi.fn().mockResolvedValue({ status: true }),
      signInSms: vi.fn(), sendSms: vi.fn(), resetPassword: vi.fn(),
      changePassword: vi.fn(), signOut: vi.fn(), getSession: vi.fn(),
    };
    render(<AuthForms client={client} />);
    await waitFor(() => expect(screen.getByLabelText("验证码")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("邮箱 / 手机号"), { target: { value: "operator@example.test" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "abcd" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(client.signInPassword).toHaveBeenCalledWith({
      loginId: "operator@example.test", password: "password1", captchaId: "captcha-identifier", captchaAnswer: "abcd",
    }));
    fireEvent.click(screen.getByRole("button", { name: "验证码登录" }));
    await waitFor(() => expect(screen.getByLabelText("手机号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByText("请输入有效的中国大陆手机号")).toBeTruthy());
    expect(client.signInSms).not.toHaveBeenCalled();
  });
});

describe("graphic challenge request ordering",()=>{
  it("serializes StrictMode generation so browser cookies and the visible challenge cannot race",async()=>{
    const release:Array<()=>void>=[];
    const captcha=vi.fn(()=>new Promise<any>(resolve=>release.push(()=>resolve({id:"captcha-identifier",image:"<svg/>",expiresAt:Date.now()+120000,serverTime:Date.now()}))));
    const client={captcha,signInPassword:vi.fn(),signInSms:vi.fn(),sendSms:vi.fn(),resetPassword:vi.fn(),changePassword:vi.fn(),signOut:vi.fn(),getSession:vi.fn()};
    render(<React.StrictMode><AuthForms client={client}/></React.StrictMode>);
    await waitFor(()=>expect(captcha).toHaveBeenCalledTimes(1));
    release.shift()!();await waitFor(()=>expect(captcha).toHaveBeenCalledTimes(2));
    release.shift()!();await waitFor(()=>expect(document.querySelector('.auth-kit__captcha-image')).toBeTruthy());
  });
});
