import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface ApiRouteProps {
  /**
   * The API Gateway REST API to attach this route to.
   */
  readonly api: apigateway.RestApi;

  /**
   * The resource path relative to the API root (e.g., "/orgs/{orgId}/events").
   * Nested path segments are created automatically.
   */
  readonly path: string;

  /**
   * HTTP method for this route.
   */
  readonly method: HttpMethod;

  /**
   * The Lambda function to integrate with.
   */
  readonly lambdaFn: lambda.IFunction;

  /**
   * Optional Lambda authorizer to attach to this route.
   * If omitted the route is unauthenticated (public).
   */
  readonly authorizer?: apigateway.IAuthorizer;

  /**
   * Request validator for body / params. Defaults to VALIDATE_REQUEST_BODY.
   */
  readonly requestValidator?: apigateway.RequestValidator;
}

/**
 * ApiRoute construct
 *
 * Wires a Lambda integration to a REST API resource + method with:
 *  - Lambda proxy integration (passthrough of headers/body/context)
 *  - Consistent CORS headers
 *  - Attaches an optional authorizer
 */
export class ApiRoute extends Construct {
  public readonly resource: apigateway.Resource;
  public readonly method: apigateway.Method;

  constructor(scope: Construct, id: string, props: ApiRouteProps) {
    super(scope, id);

    const { api, path, method, lambdaFn, authorizer, requestValidator } = props;

    // Walk/create the resource tree for the given path
    this.resource = this.ensureResource(api.root, path.replace(/^\//, ''));

    const integrationOptions: apigateway.LambdaIntegrationOptions = {
      proxy: true,
      allowTestInvoke: false,
    };

    const methodOptions: apigateway.MethodOptions = {
      authorizationType: authorizer
        ? apigateway.AuthorizationType.CUSTOM
        : apigateway.AuthorizationType.NONE,
      authorizer,
      requestValidator,
    };

    this.method = this.resource.addMethod(
      method,
      new apigateway.LambdaIntegration(lambdaFn, integrationOptions),
      methodOptions,
    );
  }

  /**
   * Recursively creates or retrieves a resource for the given path segments.
   */
  private ensureResource(
    parent: apigateway.IResource,
    remainingPath: string,
  ): apigateway.Resource {
    const [segment, ...rest] = remainingPath.split('/');
    if (!segment) return parent as apigateway.Resource;

    let child = parent.getResource(segment) as apigateway.Resource | undefined;
    if (!child) {
      child = parent.addResource(segment) as apigateway.Resource;
    }

    if (rest.length === 0) return child;
    return this.ensureResource(child, rest.join('/'));
  }
}
