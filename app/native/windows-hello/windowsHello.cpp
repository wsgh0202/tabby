#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <roapi.h>
#include <userconsentverifierinterop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <node_api.h>
#include <cstring>
#include <memory>
#include <string>

using namespace winrt::Windows::Foundation;
using namespace winrt::Windows::Security::Credentials::UI;

struct HelloRequest {
    napi_async_work work{};
    napi_deferred deferred{};
    HWND window{};
    std::string message;
    bool succeeded{};
};

static void execute(napi_env, void* data) {
    auto& request = *static_cast<HelloRequest*>(data);
    if (FAILED(RoInitialize(RO_INIT_MULTITHREADED))) {
        return;
    }
    try {
        if (UserConsentVerifier::CheckAvailabilityAsync().get() == UserConsentVerifierAvailability::Available) {
            if (request.window) {
                auto interop = winrt::get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>();
                const auto message = winrt::to_hstring(request.message);
                auto operation = winrt::capture<IAsyncOperation<UserConsentVerificationResult>>(
                    interop, &IUserConsentVerifierInterop::RequestVerificationForWindowAsync, request.window,
                    reinterpret_cast<HSTRING>(winrt::get_abi(message)));
                request.succeeded = operation.get() == UserConsentVerificationResult::Verified;
            } else {
                request.succeeded = true;
            }
        }
    } catch (...) {
        // Unavailable, denied, or failed verification leaves password unlock available.
    }
    RoUninitialize();
}

static void complete(napi_env env, napi_status status, void* data) {
    std::unique_ptr<HelloRequest> request(static_cast<HelloRequest*>(data));
    napi_value result;
    napi_get_boolean(env, status == napi_ok && request->succeeded, &result);
    napi_resolve_deferred(env, request->deferred, result);
    napi_delete_async_work(env, request->work);
}

static napi_value start(napi_env env, napi_callback_info info) {
    auto request = std::make_unique<HelloRequest>();
    napi_value args[2];
    size_t count = 2;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 0) {
        void* handle;
        size_t length;
        char message[256];
        if (count != 2 || napi_get_buffer_info(env, args[0], &handle, &length) != napi_ok || length != sizeof(HWND) ||
            napi_get_value_string_utf8(env, args[1], message, sizeof(message), &length) != napi_ok) {
            napi_throw_type_error(env, nullptr, "Expected a window handle and a verification message");
            return nullptr;
        }
        std::memcpy(&request->window, handle, sizeof(HWND));
        DWORD processId = 0;
        GetWindowThreadProcessId(request->window, &processId);
        if (processId != GetCurrentProcessId()) {
            napi_throw_type_error(env, nullptr, "Invalid verification window");
            return nullptr;
        }
        request->message.assign(message, length);
    }

    napi_value promise, name;
    napi_create_promise(env, &request->deferred, &promise);
    napi_create_string_utf8(env, "Windows Hello", NAPI_AUTO_LENGTH, &name);
    if (napi_create_async_work(env, nullptr, name, execute, complete, request.get(), &request->work) == napi_ok) {
        if (napi_queue_async_work(env, request->work) == napi_ok) {
            request.release();
            return promise;
        }
        napi_delete_async_work(env, request->work);
    }
    napi_value unavailable;
    napi_get_boolean(env, false, &unavailable);
    napi_resolve_deferred(env, request->deferred, unavailable);
    return promise;
}

static napi_value init(napi_env env, napi_value exports) {
    napi_value verify;
    napi_create_function(env, "verify", NAPI_AUTO_LENGTH, start, nullptr, &verify);
    napi_set_named_property(env, exports, "verify", verify);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
